import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign as cryptoSign,
} from "node:crypto";
import {
  startTestApp,
  api,
  authed,
  makeAppleIdp,
  TEST_APPLE_CLIENT_ID,
} from "./helpers.mjs";
import { b64urlJson, verifyHS256, verifyRS256, decodeJwtUnsafe } from "../src/jwt.js";

// A local Apple IDP with full control over the claim set — the shared helper
// cannot mint nonce/jti claims or pick an iat. Each mint gets a distinct iat
// so that two mints are two DIFFERENT authorizations; replaying one
// authorization means presenting the same token string twice.
function makeIdp({ kid = "local-key-1" } = {}) {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" };
  const jwks = { keys: [jwk] };
  let seq = 0;

  function mintIdentityToken(claims = {}) {
    const nowSec = Math.floor(Date.now() / 1000);
    seq += 1;
    const header = b64urlJson({ alg: "RS256", kid, typ: "JWT" });
    const payload = b64urlJson({
      iss: "https://appleid.apple.com",
      aud: TEST_APPLE_CLIENT_ID,
      sub: "local-sub",
      iat: nowSec + seq,
      exp: nowSec + 900,
      ...claims,
    });
    const sig = cryptoSign(
      "RSA-SHA256",
      Buffer.from(`${header}.${payload}`),
      privateKey,
    ).toString("base64url");
    return `${header}.${payload}.${sig}`;
  }

  return { jwks, mintIdentityToken, jwksFetcher: async () => jwks };
}

function sha256hex(s) {
  return createHash("sha256").update(s).digest("hex");
}

const b64 = (s) => Buffer.from(s).toString("base64url");

test("Sign in with Apple: valid identity token yields session + refresh", async () => {
  const t = await startTestApp();
  try {
    const token = t.idp.mintIdentityToken({ sub: "sub-abc", email: "a@b.com" });
    const res = await api(t.baseUrl, "POST", "/v1/auth/apple", {
      body: { identityToken: token },
    });
    assert.equal(res.status, 200);
    assert.ok(res.json.sessionToken);
    assert.ok(res.json.refreshToken);
    assert.ok(res.json.accountId);
    assert.equal(res.json.expiresIn, t.config.sessionTtlSec);

    // Session works against an authed endpoint.
    const acct = await api(t.baseUrl, "GET", "/v1/account", authed(res.json.sessionToken));
    assert.equal(acct.status, 200);
    assert.equal(acct.json.account.email, "a@b.com");
    // Default entitlement granted.
    assert.deepEqual(acct.json.entitlements, [{ feature: "nodes.max", value: "1" }]);

    // Second sign-in with the same sub maps to the same account. The expSec
    // bump makes this a genuinely SECOND authorization (distinct iat) rather
    // than a replay of the first — identity tokens are single-use now.
    const again = await api(t.baseUrl, "POST", "/v1/auth/apple", {
      body: {
        identityToken: t.idp.mintIdentityToken({
          sub: "sub-abc",
          expSec: Math.floor(Date.now() / 1000) + 900,
        }),
      },
    });
    assert.equal(again.status, 200);
    assert.equal(again.json.accountId, res.json.accountId);
  } finally {
    await t.close();
  }
});

test("Sign in with Apple: tampered, wrong-audience, expired, unknown-kid tokens rejected", async () => {
  const t = await startTestApp();
  try {
    // Tampered payload (signature no longer matches).
    const good = t.idp.mintIdentityToken();
    const [h, p, s] = good.split(".");
    const evil = JSON.parse(Buffer.from(p, "base64url").toString());
    evil.sub = "attacker";
    const tampered = `${h}.${Buffer.from(JSON.stringify(evil)).toString("base64url")}.${s}`;
    let res = await api(t.baseUrl, "POST", "/v1/auth/apple", {
      body: { identityToken: tampered },
    });
    assert.equal(res.status, 401);

    // Wrong audience.
    res = await api(t.baseUrl, "POST", "/v1/auth/apple", {
      body: { identityToken: t.idp.mintIdentityToken({ aud: "com.other.app" }) },
    });
    assert.equal(res.status, 401);

    // Expired.
    res = await api(t.baseUrl, "POST", "/v1/auth/apple", {
      body: {
        identityToken: t.idp.mintIdentityToken({
          expSec: Math.floor(Date.now() / 1000) - 10,
        }),
      },
    });
    assert.equal(res.status, 401);

    // Signed by a different key (unknown kid → rejected; same kid, other key → bad sig).
    const otherIdp = makeAppleIdp({ kid: "rogue-key" });
    res = await api(t.baseUrl, "POST", "/v1/auth/apple", {
      body: { identityToken: otherIdp.mintIdentityToken() },
    });
    assert.equal(res.status, 401);
    res = await api(t.baseUrl, "POST", "/v1/auth/apple", {
      body: { identityToken: otherIdp.mintIdentityToken({ headerKid: "test-key-1" }) },
    });
    assert.equal(res.status, 401);

    // Wrong issuer.
    res = await api(t.baseUrl, "POST", "/v1/auth/apple", {
      body: {
        identityToken: t.idp.mintIdentityToken({ iss: "https://evil.example" }),
      },
    });
    assert.equal(res.status, 401);
  } finally {
    await t.close();
  }
});

test("session JWT: garbage and expired sessions rejected; refresh rotates", async () => {
  const t = await startTestApp();
  try {
    const token = t.idp.mintIdentityToken({ aud: TEST_APPLE_CLIENT_ID });
    const login = await api(t.baseUrl, "POST", "/v1/auth/apple", {
      body: { identityToken: token },
    });
    assert.equal(login.status, 200);

    // Garbage bearer.
    let res = await api(t.baseUrl, "GET", "/v1/account", authed("not-a-jwt"));
    assert.equal(res.status, 401);

    // Expired session (advance the app clock past TTL).
    t.clock.t += (t.config.sessionTtlSec + 5) * 1000;
    res = await api(t.baseUrl, "GET", "/v1/account", authed(login.json.sessionToken));
    assert.equal(res.status, 401);

    // Refresh still valid → new session works.
    const refreshed = await api(t.baseUrl, "POST", "/v1/auth/refresh", {
      body: { refreshToken: login.json.refreshToken },
    });
    assert.equal(refreshed.status, 200);
    assert.notEqual(refreshed.json.sessionToken, login.json.sessionToken);
    res = await api(t.baseUrl, "GET", "/v1/account", authed(refreshed.json.sessionToken));
    assert.equal(res.status, 200);

    // Rotation: the old refresh token is single-use.
    const replay = await api(t.baseUrl, "POST", "/v1/auth/refresh", {
      body: { refreshToken: login.json.refreshToken },
    });
    assert.equal(replay.status, 401);
  } finally {
    await t.close();
  }
});

// Split out of the test above: replaying a spent refresh token now revokes the
// whole family, so token expiry has to be exercised on an untainted chain.
test("refresh token expiry rejected on an untainted chain", async () => {
  const t = await startTestApp();
  try {
    const login = await api(t.baseUrl, "POST", "/v1/auth/apple", {
      body: { identityToken: t.idp.mintIdentityToken() },
    });
    assert.equal(login.status, 200);
    t.clock.t += (t.config.refreshTtlSec + 5) * 1000;
    const late = await api(t.baseUrl, "POST", "/v1/auth/refresh", {
      body: { refreshToken: login.json.refreshToken },
    });
    assert.equal(late.status, 401);
  } finally {
    await t.close();
  }
});

test("magic link: request records mail, confirm signs in, reuse and expiry rejected", async () => {
  const t = await startTestApp();
  try {
    const res = await api(t.baseUrl, "POST", "/v1/auth/magic-link/request", {
      body: { email: "New.User@Example.com" },
    });
    assert.equal(res.status, 202);
    assert.equal(t.mail.sent.length, 1);
    assert.equal(t.mail.sent[0].to, "new.user@example.com");
    const match = t.mail.sent[0].text.match(/token=([A-Za-z0-9_-]+)/);
    assert.ok(match, "mail contains a token link");
    const linkToken = match[1];

    // Confirm → session for a fresh account with default entitlements.
    const confirm = await api(t.baseUrl, "POST", "/v1/auth/magic-link/confirm", {
      body: { token: linkToken },
    });
    assert.equal(confirm.status, 200);
    const acct = await api(t.baseUrl, "GET", "/v1/account", authed(confirm.json.sessionToken));
    assert.equal(acct.json.account.email, "new.user@example.com");

    // Reuse rejected.
    const reuse = await api(t.baseUrl, "POST", "/v1/auth/magic-link/confirm", {
      body: { token: linkToken },
    });
    assert.equal(reuse.status, 401);

    // Expired link rejected.
    await api(t.baseUrl, "POST", "/v1/auth/magic-link/request", {
      body: { email: "late@example.com" },
    });
    const lateToken = t.mail.sent[1].text.match(/token=([A-Za-z0-9_-]+)/)[1];
    t.clock.t += (t.config.magicLinkTtlSec + 5) * 1000;
    const late = await api(t.baseUrl, "POST", "/v1/auth/magic-link/confirm", {
      body: { token: lateToken },
    });
    assert.equal(late.status, 401);

    // Invalid email rejected.
    const bad = await api(t.baseUrl, "POST", "/v1/auth/magic-link/request", {
      body: { email: "not-an-email" },
    });
    assert.equal(bad.status, 400);
    assert.equal(t.mail.sent.length, 2);
  } finally {
    await t.close();
  }
});

test("responses never leak secrets and carry no-store", async () => {
  const t = await startTestApp();
  try {
    const login = await api(t.baseUrl, "POST", "/v1/auth/apple", {
      body: { identityToken: t.idp.mintIdentityToken() },
    });
    assert.equal(login.headers.get("cache-control"), "no-store");
    const body = JSON.stringify(login.json);
    assert.ok(!body.includes(t.config.sessionSecret));
    assert.ok(!body.includes(t.config.adminToken));
    assert.ok(!body.includes(t.config.brokerToken));
  } finally {
    await t.close();
  }
});

// ── DEFECT 1: apple_sub must be persisted when an existing account adopts it ──
test("DEFECT 1: Apple adoption of a magic-link account persists apple_sub and is idempotent", async () => {
  const idp = makeIdp();
  const t = await startTestApp({ idp });
  try {
    // Magic-link account first — no apple_sub yet.
    await api(t.baseUrl, "POST", "/v1/auth/magic-link/request", {
      body: { email: "adopt@example.com" },
    });
    const linkToken = t.mail.sent[0].text.match(/token=([A-Za-z0-9_-]+)/)[1];
    const confirm = await api(t.baseUrl, "POST", "/v1/auth/magic-link/confirm", {
      body: { token: linkToken },
    });
    assert.equal(confirm.status, 200);
    const accountId = confirm.json.accountId;
    assert.equal(t.app.registry.getAccount(accountId).appleSub, null);

    // Apple sign-in with the same address adopts that account…
    const adopt = await api(t.baseUrl, "POST", "/v1/auth/apple", {
      body: {
        identityToken: idp.mintIdentityToken({
          sub: "sub-adopted",
          email: "adopt@example.com",
        }),
      },
    });
    assert.equal(adopt.status, 200);
    assert.equal(adopt.json.accountId, accountId);

    // …and PERSISTS the sub. Without this the guard stays open forever.
    assert.equal(
      t.app.registry.getAccount(accountId).appleSub,
      "sub-adopted",
      "apple_sub must be written at adoption",
    );
    assert.equal(
      t.app.registry.findAccountByAppleSub("sub-adopted").id,
      accountId,
      "the account must now be reachable by its Apple identity",
    );

    // The account is no longer hostage to the address: a later sign-in whose
    // email claim has changed still resolves to the same account by sub, and
    // does not spawn an orphan.
    const later = await api(t.baseUrl, "POST", "/v1/auth/apple", {
      body: {
        identityToken: idp.mintIdentityToken({
          sub: "sub-adopted",
          email: "changed@example.com",
        }),
      },
    });
    assert.equal(later.status, 200);
    assert.equal(later.json.accountId, accountId);
    assert.equal(
      t.app.registry.findAccountByEmail("changed@example.com"),
      null,
      "no second account may be created for the new address",
    );
  } finally {
    await t.close();
  }
});

// ── DEFECT 2: a UNIQUE(email) collision must not escape as a 500 ─────────────
test("DEFECT 2: a second Apple identity claiming a taken address reconciles, never 500s", async () => {
  const idp = makeIdp();
  const t = await startTestApp({ idp });
  try {
    const first = await api(t.baseUrl, "POST", "/v1/auth/apple", {
      body: {
        identityToken: idp.mintIdentityToken({
          sub: "sub-original",
          email: "shared@example.com",
        }),
      },
    });
    assert.equal(first.status, 200);

    // Same verified address, a DIFFERENT apple_sub. accounts.email is UNIQUE,
    // so the naive path inserts and raises — locking this user out for good.
    const second = await api(t.baseUrl, "POST", "/v1/auth/apple", {
      body: {
        identityToken: idp.mintIdentityToken({
          sub: "sub-rotated",
          email: "shared@example.com",
        }),
      },
    });
    assert.notEqual(second.status, 500, "a constraint error must never surface as a 500");
    assert.equal(second.status, 200);
    assert.equal(second.json.accountId, first.json.accountId);

    // Reconciled onto the existing account WITHOUT rebinding its Apple identity.
    assert.equal(
      t.app.registry.getAccount(first.json.accountId).appleSub,
      "sub-original",
    );
    assert.equal(t.app.registry.findAccountByAppleSub("sub-rotated"), null);

    // And the session it handed back actually works.
    const acct = await api(t.baseUrl, "GET", "/v1/account", authed(second.json.sessionToken));
    assert.equal(acct.status, 200);
    assert.equal(acct.json.account.id, first.json.accountId);
  } finally {
    await t.close();
  }
});

// ── DEFECT 3: one human, one account, whichever path they arrive on ──────────
test("DEFECT 3: email normalization is identical on the magic-link and Apple paths", async () => {
  const idp = makeIdp();
  const t = await startTestApp({ idp });
  try {
    await api(t.baseUrl, "POST", "/v1/auth/magic-link/request", {
      body: { email: "  Mixed.Case@Example.COM  " },
    });
    assert.equal(t.mail.sent[0].to, "mixed.case@example.com");
    const linkToken = t.mail.sent[0].text.match(/token=([A-Za-z0-9_-]+)/)[1];
    const confirm = await api(t.baseUrl, "POST", "/v1/auth/magic-link/confirm", {
      body: { token: linkToken },
    });
    assert.equal(confirm.status, 200);
    const accountId = confirm.json.accountId;
    assert.equal(t.app.registry.getAccount(accountId).email, "mixed.case@example.com");

    // Apple hands back the same address in a different case. One human ⇒ one
    // account: this must adopt, not fork.
    const apple = await api(t.baseUrl, "POST", "/v1/auth/apple", {
      body: {
        identityToken: idp.mintIdentityToken({
          sub: "sub-case",
          email: "MIXED.Case@EXAMPLE.com",
        }),
      },
    });
    assert.equal(apple.status, 200);
    assert.equal(
      apple.json.accountId,
      accountId,
      "a case-different address must not create a second account",
    );
    assert.equal(t.app.registry.getAccount(accountId).appleSub, "sub-case");

    // Lookups normalize too, so a caller cannot miss a row by casing/padding.
    assert.equal(
      t.app.registry.findAccountByEmail("  MIXED.CASE@example.COM ").id,
      accountId,
    );

    // A brand-new Apple account stores the normalized form as well.
    const fresh = await api(t.baseUrl, "POST", "/v1/auth/apple", {
      body: {
        identityToken: idp.mintIdentityToken({
          sub: "sub-fresh",
          email: "Fresh.Person@Example.Com",
        }),
      },
    });
    assert.equal(fresh.status, 200);
    assert.equal(
      t.app.registry.getAccount(fresh.json.accountId).email,
      "fresh.person@example.com",
    );
  } finally {
    await t.close();
  }
});

// ── DEFECT 4: malformed tokens are 401s, never 500s ──────────────────────────
test("DEFECT 4: JWT verification is total — no malformed token can throw", async () => {
  const secret = "test-session-secret-must-be-long-enough-000";
  const validPayload = b64(JSON.stringify({ exp: 9999999999, typ: "session", sub: "x" }));

  // Tokens that must not even decode: the shape itself is wrong.
  const undecodable = [
    `${b64("null")}.${validPayload}.AAAA`, // header decodes to null  ← the crash
    `${b64("[]")}.${validPayload}.AAAA`, // header is an array
    `${b64("7")}.${validPayload}.AAAA`, // header is a number
    `${b64('"HS256"')}.${validPayload}.AAAA`, // header is a string
    `${b64('{"alg":"HS256"}')}.${b64("null")}.AAAA`, // claims decode to null
    `${b64('{"alg":"HS256"}')}.${b64("[]")}.AAAA`, // claims are an array
    `${b64('{"alg":"none"}')}.${validPayload}.`, // empty signature
    "a.b", // two segments
    "a.b.c.d", // four segments
    "...", // empty segments
    "!!!.???.***", // outside the base64url alphabet
    "", // empty
    "not-a-jwt",
  ];

  // Decodable but never verifiable: the crypto envelope is missing or wrong.
  const unverifiable = [
    ...undecodable,
    `${b64('{"typ":"JWT"}')}.${validPayload}.AAAA`, // no alg
    `${b64('{"alg":"none"}')}.${validPayload}.AAAA`, // alg none
    `${b64('{"alg":"RS256"}')}.${validPayload}.AAAA`, // no kid, wrong family for HS256
    `${b64('{"alg":"HS256"}')}.${validPayload}.AAAA`, // alg ok, signature garbage
  ];

  for (const token of undecodable) {
    assert.equal(decodeJwtUnsafe(token), null, `decode: ${token}`);
  }
  for (const token of unverifiable) {
    assert.equal(verifyHS256(token, secret, 1000), null, `HS256: ${token}`);
    assert.equal(verifyRS256(token, { kty: "RSA", n: "AA", e: "AQAB" }), null, `RS256: ${token}`);
  }
  const malformed = unverifiable;

  // Non-string inputs are inputs too.
  for (const bad of [null, undefined, 42, {}, [], Buffer.from("x")]) {
    assert.equal(decodeJwtUnsafe(bad), null);
    assert.equal(verifyHS256(bad, secret, 1000), null);
  }

  // Over the wire: an unauthenticated request must not become a 500.
  const idp = makeIdp();
  const t = await startTestApp({ idp });
  try {
    for (const token of malformed) {
      const res = await api(t.baseUrl, "GET", "/v1/account", authed(token));
      assert.equal(res.status, 401, `bearer ${token} → 401, got ${res.status}`);
    }
    // Same on the unauthenticated Apple path, which reads header.kid.
    for (const token of malformed) {
      const res = await api(t.baseUrl, "POST", "/v1/auth/apple", {
        body: { identityToken: token },
      });
      assert.equal(res.status, 401, `apple ${token} → 401, got ${res.status}`);
    }
  } finally {
    await t.close();
  }
});

// ── DEFECT 5: reuse detection + a revocation path ────────────────────────────
test("DEFECT 5: replaying a spent refresh token kills the whole family", async () => {
  const idp = makeIdp();
  const t = await startTestApp({ idp });
  try {
    const login = await api(t.baseUrl, "POST", "/v1/auth/apple", {
      body: { identityToken: idp.mintIdentityToken({ sub: "sub-reuse" }) },
    });
    assert.equal(login.status, 200);

    // Legitimate rotation.
    const rotated = await api(t.baseUrl, "POST", "/v1/auth/refresh", {
      body: { refreshToken: login.json.refreshToken },
    });
    assert.equal(rotated.status, 200);

    // A thief replays the stolen (already spent) token.
    const replay = await api(t.baseUrl, "POST", "/v1/auth/refresh", {
      body: { refreshToken: login.json.refreshToken },
    });
    assert.equal(replay.status, 401);

    // …which must invalidate the successor as well: the chain is compromised
    // and neither party gets to keep it.
    const successor = await api(t.baseUrl, "POST", "/v1/auth/refresh", {
      body: { refreshToken: rotated.json.refreshToken },
    });
    assert.equal(
      successor.status,
      401,
      "reuse detection must revoke the whole family, not just the replayed token",
    );
    assert.equal(
      t.app.registry.countLiveRefreshTokens(login.json.accountId, t.clock.t),
      0,
    );

    // Re-authenticating gives a clean, working chain.
    const back = await api(t.baseUrl, "POST", "/v1/auth/apple", {
      body: { identityToken: idp.mintIdentityToken({ sub: "sub-reuse" }) },
    });
    assert.equal(back.status, 200);
    assert.equal(back.json.accountId, login.json.accountId);
    const ok = await api(t.baseUrl, "POST", "/v1/auth/refresh", {
      body: { refreshToken: back.json.refreshToken },
    });
    assert.equal(ok.status, 200);
  } finally {
    await t.close();
  }
});

test("DEFECT 5: revokeAll drops refresh tokens AND already-issued sessions", async () => {
  const idp = makeIdp();
  const t = await startTestApp({ idp });
  try {
    const a = await api(t.baseUrl, "POST", "/v1/auth/apple", {
      body: { identityToken: idp.mintIdentityToken({ sub: "sub-revoke" }) },
    });
    const b = await api(t.baseUrl, "POST", "/v1/auth/apple", {
      body: { identityToken: idp.mintIdentityToken({ sub: "sub-revoke" }) },
    });
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(a.json.accountId, b.json.accountId);
    const accountId = a.json.accountId;

    // A bystander account must be untouched by any of this.
    const other = await api(t.baseUrl, "POST", "/v1/auth/apple", {
      body: {
        identityToken: idp.mintIdentityToken({ sub: "sub-bystander", email: "by@example.com" }),
      },
    });
    assert.equal(other.status, 200);

    for (const s of [a, b]) {
      const res = await api(t.baseUrl, "GET", "/v1/account", authed(s.json.sessionToken));
      assert.equal(res.status, 200);
    }

    const result = t.app.auth.revokeAll(accountId);
    assert.equal(result.ok, true);
    assert.equal(result.refreshTokensRevoked, 2);

    // Every session minted before the revocation is dead…
    for (const s of [a, b]) {
      const res = await api(t.baseUrl, "GET", "/v1/account", authed(s.json.sessionToken));
      assert.equal(res.status, 401, "revokeAll must invalidate live session JWTs");
      const refreshed = await api(t.baseUrl, "POST", "/v1/auth/refresh", {
        body: { refreshToken: s.json.refreshToken },
      });
      assert.equal(refreshed.status, 401);
    }

    // …but nobody else's is.
    const bystander = await api(t.baseUrl, "GET", "/v1/account", authed(other.json.sessionToken));
    assert.equal(bystander.status, 200);

    // Signing in again works immediately, on the same frozen clock.
    const back = await api(t.baseUrl, "POST", "/v1/auth/apple", {
      body: { identityToken: idp.mintIdentityToken({ sub: "sub-revoke" }) },
    });
    assert.equal(back.status, 200);
    assert.equal(back.json.accountId, accountId);
    const acct = await api(t.baseUrl, "GET", "/v1/account", authed(back.json.sessionToken));
    assert.equal(acct.status, 200);

    // Unknown account is a clean null, not a throw.
    assert.equal(t.app.auth.revokeAll("no-such-account"), null);
    assert.equal(t.app.auth.revokeAll(null), null);
  } finally {
    await t.close();
  }
});

// ── DEFECT 6: identity tokens are one-shot and nonce-bindable ────────────────
test("DEFECT 6: an Apple identity token mints exactly one session", async () => {
  const idp = makeIdp();
  const t = await startTestApp({ idp });
  try {
    const token = idp.mintIdentityToken({ sub: "sub-once", email: "once@example.com" });

    const first = await api(t.baseUrl, "POST", "/v1/auth/apple", {
      body: { identityToken: token },
    });
    assert.equal(first.status, 200);

    // A leaked identity token is valid to Apple for minutes; without single
    // use it mints unlimited 30-day refresh chains in that window.
    for (let i = 0; i < 3; i += 1) {
      const replay = await api(t.baseUrl, "POST", "/v1/auth/apple", {
        body: { identityToken: token },
      });
      assert.equal(replay.status, 401, "an identity token must be single-use");
    }

    // Only the one legitimate chain exists.
    assert.equal(
      t.app.registry.countLiveRefreshTokens(first.json.accountId, t.clock.t),
      1,
    );

    // A genuinely new authorization still works.
    const again = await api(t.baseUrl, "POST", "/v1/auth/apple", {
      body: { identityToken: idp.mintIdentityToken({ sub: "sub-once" }) },
    });
    assert.equal(again.status, 200);
    assert.equal(again.json.accountId, first.json.accountId);
  } finally {
    await t.close();
  }
});

test("DEFECT 6: identity tokens are bound to the client-supplied nonce", async () => {
  const idp = makeIdp();
  const t = await startTestApp({ idp });
  try {
    // Client flow being modelled (this is what a real Sign in with Apple
    // client must do for the binding to exist):
    //   1. rawNonce = 32 random bytes, base64url
    //   2. ASAuthorizationAppleIDRequest.nonce = sha256hex(rawNonce)
    //   3. POST /v1/auth/apple { identityToken, nonce: rawNonce }
    // Apple copies the string from step 2 verbatim into the `nonce` claim.
    const rawNonce = randomBytes(32).toString("base64url");
    const hashed = idp.mintIdentityToken({
      sub: "sub-nonce",
      nonce: sha256hex(rawNonce),
    });

    // Stripping the nonce from the request must NOT bypass the binding —
    // otherwise a leaked token is as good as ever.
    assert.equal(await t.app.auth.appleSignIn(hashed), null);
    assert.equal(await t.app.auth.appleSignIn(hashed, { nonce: "" }), null);
    // Nor may a wrong nonce pass.
    assert.equal(
      await t.app.auth.appleSignIn(hashed, { nonce: randomBytes(32).toString("base64url") }),
      null,
    );
    // The real nonce does.
    const session = await t.app.auth.appleSignIn(hashed, { nonce: rawNonce });
    assert.ok(session?.sessionToken);
    // …exactly once.
    assert.equal(await t.app.auth.appleSignIn(hashed, { nonce: rawNonce }), null);

    // The other conventional client shape — request.nonce set to the raw
    // value — is accepted too, so no client is forced to change its hashing.
    const raw2 = randomBytes(32).toString("base64url");
    const plain = idp.mintIdentityToken({ sub: "sub-nonce", nonce: raw2 });
    assert.equal(await t.app.auth.appleSignIn(plain, { nonce: "wrong" }), null);
    assert.ok((await t.app.auth.appleSignIn(plain, { nonce: raw2 }))?.sessionToken);

    // A nonce offered for a token that carries none is a mismatch, not a
    // silent pass.
    const noNonce = idp.mintIdentityToken({ sub: "sub-nonce" });
    assert.equal(await t.app.auth.appleSignIn(noNonce, { nonce: raw2 }), null);
    // …and that token is still unspent, so the nonce-free flow keeps working.
    assert.ok((await t.app.auth.appleSignIn(noNonce))?.sessionToken);
  } finally {
    await t.close();
  }
});
