// Auth: Sign in with Apple (server-side identity-token verification against
// Apple JWKS via an injectable fetcher), email magic link (injectable mail
// transport), short-lived HS256 session JWTs + rotating opaque refresh tokens.
//
// Sessions authorize control-plane actions only (rendezvous, pairing, push
// routing, registry). They are NEVER accepted by nodes — the data path is
// mTLS-only, per the security invariants.
//
// Identity resolution rules, in one place so the two sign-in paths cannot
// drift apart:
//   * An address is only ever compared or stored after normalizeEmail().
//   * apple_sub is the primary key of an Apple identity. It is PERSISTED the
//     first time it is seen, including when an existing magic-link account
//     adopts it, so adoption happens exactly once and survives an address
//     change.
//   * accounts.email and accounts.apple_sub are UNIQUE. Every path that could
//     collide resolves deterministically to an existing account; a constraint
//     error must never reach the HTTP layer as a 500.

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { signHS256, verifyHS256, decodeJwtUnsafe, verifyRS256 } from "./jwt.js";
import { normalizeEmail } from "./registry.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function sha256hex(input) {
  return createHash("sha256").update(input).digest("hex");
}

// Length-independent constant-time compare: hash both sides to a fixed width
// first so timingSafeEqual can be used on values whose lengths differ.
function secretEquals(a, b) {
  return timingSafeEqual(
    createHash("sha256").update(String(a)).digest(),
    createHash("sha256").update(String(b)).digest(),
  );
}

// Default JWKS fetcher: pulls Apple's keys with global fetch, cached 5 min.
// Tests inject their own fetcher returning a fake JWKS.
export function createAppleJwksFetcher(url, { ttlMs = 5 * 60 * 1000 } = {}) {
  let cache = null;
  let cachedAt = 0;
  return async () => {
    if (cache && Date.now() - cachedAt < ttlMs) return cache;
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`jwks fetch failed: ${res.status}`);
    cache = await res.json();
    cachedAt = Date.now();
    return cache;
  };
}

export function createAuth({
  registry,
  config,
  jwksFetcher,
  mailTransport,
  now = () => Date.now(),
}) {
  function grantDefaults(account) {
    registry.setEntitlement(account.id, "nodes.max", String(config.defaultMaxNodes));
  }

  function issueSession(account, { cliLinkId = null } = {}) {
    const iat = Math.floor(now() / 1000);
    const sessionToken = signHS256(
      {
        sub: account.id,
        typ: "session",
        iat,
        exp: iat + config.sessionTtlSec,
        jti: randomUUID(),
        // Revocation epoch this session was minted under. authenticate()
        // rejects the token once the account's epoch moves past it, which is
        // what lets revokeAll() reach sessions that are already in the wild.
        sep: registry.getSessionEpoch(account.id),
        // CLI sessions are capabilities for one explicitly linked computer.
        // authenticate() checks that this exact link still exists, so the
        // phone can disconnect it immediately without revoking phone sessions.
        ...(cliLinkId ? { cli: cliLinkId } : {}),
      },
      config.sessionSecret,
    );
    const refreshToken = randomBytes(32).toString("base64url");
    registry.insertRefreshToken({
      accountId: account.id,
      tokenHash: sha256hex(refreshToken), // hashed at rest; the plaintext only ever leaves in this response
      cliLinkId,
      expiresAt: now() + config.refreshTtlSec * 1000,
    });
    return {
      sessionToken,
      refreshToken,
      expiresIn: config.sessionTtlSec,
      accountId: account.id,
    };
  }

  // ── Sign in with Apple ──────────────────────────────────────────────────
  //
  // Pure verification: no writes, no side effects. Returns the identity plus
  // the material appleSignIn() needs to enforce single use, or null.
  //
  // `nonce` is the RAW value the client generated for this authorization.
  // A real Sign in with Apple client sets ASAuthorizationAppleIDRequest.nonce
  // to either that raw value or to its SHA-256 hex digest (both conventions
  // are in wide use; Apple copies whatever string it is given verbatim into
  // the `nonce` claim), then sends the raw value to us alongside the token.
  // We accept either convention so no client is forced to change its hashing.
  //
  // REQUIRED CLIENT BEHAVIOUR to get nonce binding: POST
  // { identityToken, nonce } to /v1/auth/apple. A token that carries a nonce
  // claim is REJECTED when the request omits the nonce, so an attacker holding
  // a leaked token cannot strip the binding by dropping the field. Clients
  // that set no nonce keep working and are protected by single-use alone.
  async function verifyAppleIdentityToken(identityToken, { nonce = null } = {}) {
    const decoded = decodeJwtUnsafe(identityToken);
    if (!decoded) return null;
    if (typeof decoded.header.kid !== "string" || !decoded.header.kid) return null;
    let jwks;
    try {
      jwks = await jwksFetcher();
    } catch {
      return null;
    }
    const jwk = (jwks?.keys || []).find((k) => k?.kid === decoded.header.kid);
    if (!jwk) return null;
    const verified = verifyRS256(identityToken, jwk);
    if (!verified) return null;
    const { payload } = verified;
    if (payload.iss !== config.appleIssuer) return null;
    if (typeof payload.aud !== "string") return null;
    if (!config.appleClientIds.includes(payload.aud)) return null;
    if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) {
      return null;
    }
    if (payload.exp * 1000 <= now()) return null;
    if (typeof payload.sub !== "string" || !payload.sub) return null;

    const claimNonce =
      typeof payload.nonce === "string" && payload.nonce ? payload.nonce : null;
    const suppliedNonce =
      typeof nonce === "string" && nonce ? nonce : null;
    if (claimNonce || suppliedNonce) {
      if (!claimNonce || !suppliedNonce) return null;
      const matches =
        secretEquals(suppliedNonce, claimNonce) ||
        secretEquals(sha256hex(suppliedNonce), claimNonce);
      if (!matches) return null;
    }

    // Apple documents email_verified as always true, but if a token ever says
    // otherwise the address is not evidence of anything and must not be used
    // to find, adopt, or create an account.
    const verifiedFlag = payload.email_verified;
    const emailUsable =
      verifiedFlag === undefined ||
      verifiedFlag === true ||
      verifiedFlag === "true";
    const email = emailUsable ? normalizeEmail(payload.email) : null;

    // Single-use key for this credential. Prefer a jti when Apple supplies
    // one; otherwise the (sub, iat, aud, nonce) tuple identifies exactly one
    // authorization. Hashed so the ledger holds no user identifier.
    const jti = typeof payload.jti === "string" && payload.jti ? payload.jti : null;
    const iat =
      typeof payload.iat === "number" && Number.isFinite(payload.iat)
        ? payload.iat
        : payload.exp;
    const replayKey = sha256hex(
      jti
        ? `apple-jti\u0000${jti}`
        : `apple-claims\u0000${payload.sub}\u0000${iat}\u0000${payload.aud}\u0000${claimNonce ?? ""}`,
    );

    return {
      sub: payload.sub,
      email: email && EMAIL_RE.test(email) ? email : null,
      replayKey,
      expiresAtMs: payload.exp * 1000,
    };
  }

  // Maps a verified Apple identity onto exactly one account row. Every branch
  // is idempotent: calling it twice with the same identity performs no second
  // write and returns the same account.
  function resolveAppleAccount({ sub, email }) {
    const bySub = registry.findAccountByAppleSub(sub);
    if (bySub) {
      // Fill in an address we did not have yet. attachEmail is a no-op when
      // the slot is taken or the address belongs to someone else.
      if (email && !bySub.email) return registry.attachEmail(bySub.id, email);
      return bySub;
    }

    const byEmail = email ? registry.findAccountByEmail(email) : null;
    if (byEmail) {
      if (!byEmail.appleSub) {
        // Adoption: an existing magic-link account claiming its Apple
        // identity. PERSISTING the sub is what makes this happen exactly
        // once — every later sign-in resolves through findAccountByAppleSub,
        // and the link survives the user changing their address.
        return registry.attachAppleSub(byEmail.id, sub);
      }
      // The address is already bound to a DIFFERENT Apple identity. Inserting
      // would violate UNIQUE(email) and surface as a 500 that locks this user
      // out permanently, so reconcile onto the account that already owns the
      // address instead. Both bindings are proof of control of that address
      // (Apple only asserts addresses it has verified for the signing Apple
      // ID; a magic link is only delivered to the address itself), so this is
      // the same human whose sub changed — e.g. an app team transfer — rather
      // than a second identity to merge. The stored apple_sub is deliberately
      // NOT rebound.
      return byEmail;
    }

    try {
      const account = registry.createAccount({ appleSub: sub, email });
      grantDefaults(account);
      return account;
    } catch {
      // Lost a race against a concurrent sign-in. Re-resolve rather than let
      // the constraint error escape; null only if the row truly is not there.
      return (
        registry.findAccountByAppleSub(sub) ||
        (email ? registry.findAccountByEmail(email) : null)
      );
    }
  }

  async function appleSignIn(identityToken, { nonce = null } = {}) {
    const identity = await verifyAppleIdentityToken(identityToken, { nonce });
    if (!identity) return null;
    // SINGLE USE. Without this an identity token that leaks (logs, a proxy, a
    // crash report) mints fresh 30-day refresh chains for as long as it is
    // unexpired. The claim is an atomic insert, so exactly one presentation
    // wins even under concurrency.
    const claimed = registry.claimAppleTokenUse({
      tokenId: identity.replayKey,
      expiresAt: identity.expiresAtMs,
      nowMs: now(),
    });
    if (!claimed) return null;
    const account = resolveAppleAccount(identity);
    if (!account) return null;
    return issueSession(account);
  }

  // ── refresh ─────────────────────────────────────────────────────────────
  function refresh(refreshToken) {
    if (typeof refreshToken !== "string" || !refreshToken) return null;
    const record = registry.findRefreshToken(sha256hex(refreshToken));
    if (!record) return null;
    if (record.revokedAt != null) {
      // REUSE DETECTED. This token was already spent, so either a thief is
      // replaying a copy or the legitimate holder's successor has been taken.
      // We cannot tell which, and in both cases the chain is compromised, so
      // the whole family dies: the owner re-authenticates once and the
      // thief's copy dies with it. Session JWTs are deliberately left alone —
      // they expire on their own within minutes and this signal can also fire
      // on a benign client retry. Owner-triggered revokeAll() drops those too.
      if (record.cliLinkId) {
        // A replay inside the computer's refresh chain disconnects that one
        // computer. It must not sign the phone (Better Auth) or unrelated
        // legacy clients out, and deleting the link also kills live CLI JWTs.
        registry.disconnectCliComputer(record.accountId, record.cliLinkId);
      } else {
        registry.revokeAllRefreshTokens(record.accountId);
      }
      return null;
    }
    if (record.expiresAt <= now()) return null;
    const account = registry.getAccount(record.accountId);
    if (!account) return null;
    if (record.cliLinkId) {
      const link = registry.getCliComputerLinkById(record.cliLinkId);
      if (!link || link.accountId !== account.id || link.connectedAt === null) {
        registry.revokeRefreshToken(record.id);
        return null;
      }
    }
    registry.revokeRefreshToken(record.id); // rotation: single use
    return issueSession(account, { cliLinkId: record.cliLinkId });
  }

  // Owner-triggered sign-out-everywhere: drops every refresh token AND
  // invalidates every session JWT already minted for the account by advancing
  // its revocation epoch. Returns null for an unknown account.
  //
  // NOT YET REACHABLE OVER HTTP — server.js owns the route table. Wire it as
  // `POST /v1/auth/revoke-all` inside the session-authed block:
  //     return sendJson(res, 200, auth.revokeAll(account.id));
  function revokeAll(accountId) {
    if (typeof accountId !== "string" || !accountId) return null;
    if (!registry.getAccount(accountId)) return null;
    const refreshTokensRevoked = registry.revokeAllRefreshTokens(accountId);
    const sessionEpoch = registry.bumpSessionEpoch(accountId);
    return { ok: true, refreshTokensRevoked, sessionEpoch };
  }

  // ── magic link ──────────────────────────────────────────────────────────
  async function requestMagicLink(rawEmail) {
    const email = normalizeEmail(rawEmail);
    if (!email || !EMAIL_RE.test(email)) return { ok: false };
    const token = randomBytes(32).toString("base64url");
    registry.insertMagicLink({
      email,
      tokenHash: sha256hex(token),
      expiresAt: now() + config.magicLinkTtlSec * 1000,
    });
    await mailTransport.send({
      to: email,
      subject: "Sign in to Relay",
      text: `Open this link to sign in: ${config.magicLinkBaseUrl}?token=${token}\nThis link expires in ${Math.round(config.magicLinkTtlSec / 60)} minutes.`,
    });
    return { ok: true };
  }

  function confirmMagicLink(token) {
    if (typeof token !== "string" || !token) return null;
    const record = registry.findMagicLink(sha256hex(token));
    if (!record) return null;
    if (record.usedAt != null || record.expiresAt <= now()) return null;
    const email = normalizeEmail(record.email);
    if (!email) return null;
    registry.markMagicLinkUsed(record.id);
    let account = registry.findAccountByEmail(email);
    if (!account) {
      try {
        account = registry.createAccount({ email });
        grantDefaults(account);
      } catch {
        // Raced with another sign-in for the same address.
        account = registry.findAccountByEmail(email);
      }
      if (!account) return null;
    }
    return issueSession(account);
  }

  // ── request authentication ──────────────────────────────────────────────
  function authenticate(req) {
    const header = req.headers?.authorization || "";
    if (!header.startsWith("Bearer ")) return null;
    const payload = verifyHS256(header.slice(7), config.sessionSecret, now());
    if (!payload || payload.typ !== "session") return null;
    if (typeof payload.sub !== "string" || !payload.sub) return null;
    const account = registry.getAccount(payload.sub);
    if (!account) return null;
    const sep = typeof payload.sep === "number" ? payload.sep : 0;
    if (sep < registry.getSessionEpoch(account.id)) return null; // revoked
    if (payload.cli !== undefined) {
      if (typeof payload.cli !== "string" || !payload.cli) return null;
      const link = registry.getCliComputerLinkById(payload.cli);
      if (!link || link.accountId !== account.id || link.connectedAt === null) return null;
    }
    return account;
  }

  // Drops spent single-use records whose underlying token has expired.
  // claimAppleTokenUse() also sweeps opportunistically, so wiring this into
  // server.js's runSweeps() is a tidiness measure, not a correctness one.
  function sweep() {
    registry.sweepAppleTokenUses(now());
  }

  return {
    appleSignIn,
    verifyAppleIdentityToken,
    refresh,
    revokeAll,
    requestMagicLink,
    confirmMagicLink,
    authenticate,
    issueSession,
    sweep,
  };
}
