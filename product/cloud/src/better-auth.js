// Better Auth integration for Relay's existing control-plane process.
// Native clients use the REST surface at /api/auth and bearer sessions.

import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { fromNodeHeaders, toNodeHandler } from "better-auth/node";
import { bearer, username } from "better-auth/plugins";
import { ENTITLEMENT_MAX_NODES } from "./registry.js";

export function createRelayBetterAuth({ db, registry, config }) {
  const appleConfigured =
    config.appleClientIds.length > 0 && config.appleClientSecret.length > 0;
  const socialProviders = appleConfigured
    ? {
        apple: {
          clientId: config.appleClientIds,
          appBundleIdentifier: config.appleClientIds[0],
          clientSecret: config.appleClientSecret,
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
        afterDelete(user) {
          const account =
            registry.getAccount(user.id) || registry.findAccountByEmail(user.email);
          if (account) registry.deleteAccount(account.id);
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
