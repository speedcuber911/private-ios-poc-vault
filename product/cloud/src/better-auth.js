// Better Auth integration for Relay's existing control-plane process.
// Native clients use the REST surface at /api/auth and bearer sessions.

import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { fromNodeHeaders, toNodeHandler } from "better-auth/node";
import { bearer, username, admin } from "better-auth/plugins";
import { ENTITLEMENT_MAX_NODES, normalizeEmail } from "./registry.js";
import { webOriginStore } from "./web-origin.js";

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
    plugins: [username(), bearer(), admin()],
    account: {
      encryptOAuthTokens: true,
      // Relay never sends verification mail, so password accounts stay
      // emailVerified=false. Better Auth's default then refuses to attach
      // Apple to that row ("account not linked") even though Apple already
      // proved the address. Trust Apple and allow the link; otherwise the
      // phone Sign in with Apple button permanently locks out anyone who
      // created the account from the web console first.
      accountLinking: {
        enabled: true,
        trustedProviders: ["apple"],
        requireLocalEmailVerified: false,
      },
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
            pinAdminRoleIfNeeded(db, config, user);
          },
        },
      },
      session: {
        create: {
          after(session) {
            try {
              const store = webOriginStore.getStore();
              const origin = store?.origin;
              const trusted = config.trustedWebOrigins || [];
              if (!origin || !trusted.includes(origin)) return;
              const reserved = registry.reserveBrowserSession({
                accountId: session.userId,
                displayName: sanitizeBrowserName(session.userAgent),
                platform: "web",
              });
              if (reserved.status === "cap") {
                if (store) store.capHit = true;
                try {
                  db.prepare("DELETE FROM session WHERE id = ?").run(session.id);
                } catch {
                  /* table missing in tests that never migrate Better Auth */
                }
                return;
              }
              registry.attachBrowserAuthSession(reserved.id, session.id);
            } catch {
              /* never fail a sign-in because the sidecar write failed */
            }
          },
        },
      },
    },
    trustedOrigins: [
      config.betterAuthBaseURL,
      ...(config.trustedWebOrigins || []),
    ],
    advanced: {
      defaultCookieAttributes: {
        // SameSite=None is what lets a cross-origin SPA send this cookie, and
        // it is also what removes the browser's built-in CSRF protection. Pay
        // that price only where a web origin is actually configured; every
        // other deployment keeps Lax.
        sameSite: (config.trustedWebOrigins || []).length > 0 ? "none" : "lax",
        secure: config.betterAuthBaseURL.startsWith("https://"),
        httpOnly: true,
      },
    },
  };

  const auth = betterAuth(options);
  const handler = toNodeHandler(auth);
  const ready = getMigrations(options).then(async ({ runMigrations }) => {
    await runMigrations();
    pinAdminEmails(db, config);
  });

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
      pinAdminRoleIfNeeded(db, config, result.user);
      return ensureRelayAccount(registry, config, result.user);
    },
  };
}

export function roleIncludesAdmin(role) {
  return String(role || "")
    .split(",")
    .map((part) => part.trim())
    .includes("admin");
}

export function isPinnedAdminEmail(email, config) {
  const normalized = normalizeEmail(email);
  return Boolean(normalized && (config.adminEmails || []).includes(normalized));
}

export function isRelayAdmin(user, account, config) {
  return (
    roleIncludesAdmin(user?.role) ||
    isPinnedAdminEmail(user?.email || account?.email, config)
  );
}

export function readBetterAuthUser(db, id) {
  if (!id) return null;
  try {
    return (
      db.prepare("SELECT id, email, name, role, banned FROM user WHERE id = ?").get(id) ||
      null
    );
  } catch {
    return null;
  }
}

export function listBetterAuthUsers(db, { limit = 50, offset = 0 } = {}) {
  try {
    const columns = db.prepare("PRAGMA table_info(user)").all().map((c) => c.name);
    const created = columns.includes("createdAt")
      ? "createdAt"
      : columns.includes("created_at")
        ? "created_at"
        : "id";
    return db
      .prepare(
        `SELECT id, email, name, role, banned, ${created} AS createdAt FROM user ORDER BY ${created} DESC LIMIT ? OFFSET ?`,
      )
      .all(limit, offset);
  } catch {
    return [];
  }
}

function pinAdminRoleIfNeeded(db, config, user) {
  if (!user?.id || !isPinnedAdminEmail(user.email, config)) return;
  if (roleIncludesAdmin(user.role)) return;
  pinAdminRole(db, user.id);
  user.role = "admin";
}

function pinAdminRole(db, userId) {
  try {
    db.prepare("UPDATE user SET role = ? WHERE id = ?").run("admin", userId);
  } catch {
    /* migrations not applied yet */
  }
}

function pinAdminEmails(db, config) {
  for (const email of config.adminEmails || []) {
    try {
      db.prepare("UPDATE user SET role = 'admin' WHERE lower(email) = ?").run(email);
    } catch {
      /* table/column missing before migrations */
    }
  }
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

function sanitizeBrowserName(value) {
  if (typeof value !== "string") return "Browser";
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!cleaned) return "Browser";
  return cleaned.slice(0, 64);
}
