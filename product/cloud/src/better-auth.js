// Better Auth integration for Relay's existing control-plane process.
// Native clients use the REST surface at /api/auth and bearer sessions.

import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { fromNodeHeaders, toNodeHandler } from "better-auth/node";
import { bearer, username } from "better-auth/plugins";
import { ENTITLEMENT_MAX_NODES } from "./registry.js";

// `beforeAccountDelete` runs while the account's control-plane rows are still
// readable and before any of them are dropped. It is where the caller releases
// resources that outlive the database — today, the account's trial sandbox,
// which keeps running (and keeps holding the user's files) unless something
// explicitly destroys it. It must not throw: deletion has to complete even
// when that cleanup cannot.
export function createRelayBetterAuth({
  db,
  registry,
  config,
  beforeAccountDelete = async () => {},
  verifyAppleIdToken = null,
}) {
  const appleConfigured =
    config.appleClientIds.length > 0 && config.appleClientSecret.length > 0;
  const socialProviders = appleConfigured
    ? {
        apple: {
          clientId: config.appleClientIds,
          appBundleIdentifier: config.appleClientIds[0],
          clientSecret: config.appleClientSecret,
          // Relay's own verifier, in place of the library's.
          //
          // Better Auth's Apple `verifyIdToken` rejected every identity token
          // the iOS app presented — `Invalid id token { provider: 'apple' }`,
          // reproduced on two separate deployments — while this
          // implementation accepted the same token on the same host, matching
          // the nonce by its SHA-256 form. Its failure is unconditional and
          // opaque: it wraps five distinct checks in a single `catch` that
          // returns false, so there is nothing to act on and no way to tell
          // which one disagreed.
          //
          // The checks here are not weaker. `verifyAppleIdentityToken`
          // validates the RS256 signature against Apple's JWKS by `kid`, the
          // issuer, expiry, and the audience against every configured client
          // id (rather than only the first), and accepts a nonce as either the
          // raw value or its SHA-256 digest — the two conventions Sign in with
          // Apple clients use. A token carrying a nonce claim is rejected when
          // the request omits it, so a leaked token cannot strip the binding.
          ...(verifyAppleIdToken
            ? {
                verifyIdToken: async (token, nonce) =>
                  Boolean(await verifyAppleIdToken(token, { nonce: nonce ?? null })),
              }
            : {}),
        },
      }
    : {};

  const options = {
    appName: "Relay",
    baseURL: config.betterAuthBaseURL,
    basePath: "/api/auth",
    secret: config.betterAuthSecret,
    database: db,
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      revokeSessionsOnPasswordReset: true,
    },
    socialProviders,
    plugins: [username(), bearer()],
    account: {
      encryptOAuthTokens: true,
    },
    user: {
      deleteUser: {
        enabled: true,
        async afterDelete(user) {
          const account =
            registry.getAccount(user.id) || registry.findAccountByEmail(user.email);
          if (!account) return;
          await beforeAccountDelete(account.id);
          registry.deleteAccount(account.id);
        },
      },
    },
    databaseHooks: {
      user: {
        create: {
          after(user) {
            ensureRelayAccount(registry, config, user);
          },
        },
      },
    },
    trustedOrigins: [config.betterAuthBaseURL],
  };

  const auth = betterAuth(options);
  const handler = toNodeHandler(auth);
  const ready = getMigrations(options).then(({ runMigrations }) => runMigrations());

  return {
    auth,
    ready,
    handler,
    appleConfigured,
    async authenticate(req) {
      await ready;
      const result = await auth.api.getSession({
        headers: fromNodeHeaders(req.headers),
      });
      if (!result?.user) return null;
      return ensureRelayAccount(registry, config, result.user);
    },
  };
}

function ensureRelayAccount(registry, config, user) {
  const account = registry.ensureAccount({ id: user.id, email: user.email });
  if (!account) throw new Error("Unable to synchronize Better Auth user");
  if (registry.getEntitlement(account.id, ENTITLEMENT_MAX_NODES) == null) {
    registry.setEntitlement(
      account.id,
      ENTITLEMENT_MAX_NODES,
      config.defaultMaxNodes,
    );
  }
  return account;
}
