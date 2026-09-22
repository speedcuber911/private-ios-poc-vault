// Artifact hosting: the control plane stores and serves the relayd tarball
// itself, in place of the release bucket the publisher used to upload to.
//
// Three properties carry this file, because each one fails silently in
// production. First, the upload names a path, so every spelling that is not
// exactly `<artifactDir>/relayd/<version>/relayd-<version>.tar.gz` must be
// refused rather than sanitised — a traversal here writes wherever the service
// user can write. Second, a published version is IMMUTABLE except for a
// byte-identical re-upload: the publisher is reproducible and a retried release
// is ordinary, while two different tarballs wearing one version would hand
// neighbouring machines different code and break the signature on one of them.
// Third, the `url` in the response is the value that gets signed into an
// announcement every machine acts on, so it comes from configuration and never
// from the request.
//
// See docs/superpowers/specs/2026-09-21-relayd-release-subscription.md.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { startTestApp, api, signIn, TEST_ADMIN_TOKEN } from "./helpers.mjs";
import { nodeRequestSigningInput } from "../src/nodeauth.js";

const NODE_ID = "node-00112233445566aa";
const VERSION = "0.2.0";
const FILENAME = `relayd-${VERSION}.tar.gz`;

// The deployment's public https origin (BETTER_AUTH_URL, written by
// deploy/install.sh from RELAY_PUBLIC_BASE_URL). Every artifact URL is built
// from this and nothing else — notably not from the Host header of the request
// that uploaded the bytes, which is why these tests reach the server on a
// random loopback port and still expect this origin back.
const PUBLIC_ORIGIN = "https://api.example.test";

const adminAuth = { headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` } };

// What ops/release-relayd actually sends: raw gzip bytes, content-typed as
// such, with the version and filename in the query string.
function upload(t, bytes, { version = VERSION, filename = FILENAME, headers = adminAuth.headers } = {}) {
  const query = new URLSearchParams();
  if (version !== null) query.set("version", version);
  if (filename !== null) query.set("filename", filename);
  return api(t.baseUrl, "POST", `/v1/admin/relayd-artifact?${query}`, {
    raw: bytes,
    headers: { "content-type": "application/gzip", ...headers },
  });
}

function download(t, path) {
  return api(t.baseUrl, "GET", path);
}

async function setup({ env = {} } = {}) {
  const artifactDir = mkdtempSync(join(tmpdir(), "relay-artifacts-"));
  const t = await startTestApp({
    env: { BETTER_AUTH_URL: PUBLIC_ORIGIN, RELAY_ARTIFACT_DIR: artifactDir, ...env },
  });
  return {
    t,
    artifactDir,
    storedPath: join(artifactDir, "relayd", VERSION, FILENAME),
    async close() {
      await t.close();
      rmSync(artifactDir, { recursive: true, force: true });
    },
  };
}

// ── upload ────────────────────────────────────────────────────────────────

test("uploading stores the bytes at one derived path and returns the URL a node will fetch", async () => {
  const { t, artifactDir, storedPath, close } = await setup();
  try {
    const bytes = crypto.randomBytes(4096);
    const res = await upload(t, bytes);
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.artifact, {
      version: VERSION,
      filename: FILENAME,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
      // Absolute, https, and built from configuration — the publisher signs
      // this URL into the announcement rather than composing one of its own.
      url: `${PUBLIC_ORIGIN}/relayd/${VERSION}/${FILENAME}`,
    });
    assert.ok(readFileSync(storedPath).equals(bytes), "the stored file is the uploaded bytes");
    assert.deepEqual(readdirSync(artifactDir), ["relayd"]);
    assert.deepEqual(readdirSync(join(artifactDir, "relayd", VERSION)), [FILENAME]);
  } finally {
    await close();
  }
});

test("the upload route stays on ADMIN_TOKEN, and a refused upload writes nothing", async () => {
  const { t, artifactDir, close } = await setup();
  try {
    const session = await signIn(t);
    const bytes = Buffer.from("tarball");

    const unauthed = await upload(t, bytes, { headers: {} });
    assert.equal(unauthed.status, 401);
    const withSession = await upload(t, bytes, {
      headers: { authorization: `Bearer ${session.sessionToken}` },
    });
    assert.equal(withSession.status, 401, "a session bearer is not ops auth");
    const wrongToken = await upload(t, bytes, {
      headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}x` },
    });
    assert.equal(wrongToken.status, 401);

    assert.deepEqual(readdirSync(artifactDir), []);
  } finally {
    await close();
  }
});

test("a bad version, a filename that disagrees with it, and a traversal are each refused by code", async () => {
  const { t, artifactDir, close } = await setup();
  try {
    const bytes = Buffer.from("tarball");
    const cases = [
      // Same canonical-version rule the publish route applies — one release,
      // one spelling — so the two halves of publishing cannot disagree about
      // what a version is called.
      ["invalid_version", { version: "0.2", filename: "relayd-0.2.tar.gz" }],
      ["invalid_version", { version: "01.2.0", filename: "relayd-01.2.0.tar.gz" }],
      ["invalid_version", { version: "0.2.0-rc1", filename: "relayd-0.2.0-rc1.tar.gz" }],
      ["invalid_version", { version: null }],
      // A version that is a path, not a version. The directory name comes from
      // this value, so it is the first thing a traversal would reach for.
      ["invalid_version", { version: "../../etc" }],
      ["invalid_version", { version: "0.2.0/../../0.3.0" }],
      ["invalid_version", { version: "0.2.0\u0000" }],
      // The filename must be the one name this version can have. Nothing is
      // derived from the value — it is compared against the derived name — so
      // every separator, dot segment and near-miss below fails the same way.
      ["invalid_filename", { filename: null }],
      ["invalid_filename", { filename: "relayd-0.3.0.tar.gz" }],
      ["invalid_filename", { filename: "relayd-0.2.0.tar" }],
      ["invalid_filename", { filename: "../../../etc/cron.d/relayd-0.2.0.tar.gz" }],
      ["invalid_filename", { filename: "../relayd-0.2.0.tar.gz" }],
      ["invalid_filename", { filename: "relayd-0.2.0.tar.gz/../../evil" }],
      ["invalid_filename", { filename: "/etc/passwd" }],
      ["invalid_filename", { filename: "relayd-0.2.0.tar.gz\u0000.txt" }],
      // An empty body would be stored, become immutable, and answer every
      // node's download with zero bytes it cannot verify.
      ["empty_artifact", { body: Buffer.alloc(0) }],
    ];
    for (const [expected, { body, ...overrides }] of cases) {
      const res = await upload(t, body ?? bytes, overrides);
      assert.equal(res.status, 400, `${JSON.stringify(overrides)} must be refused`);
      assert.equal(res.json.error, expected, JSON.stringify(overrides));
    }

    assert.deepEqual(readdirSync(artifactDir), [], "nothing above may create a path");
  } finally {
    await close();
  }
});

test("a version is canonicalised to one spelling, and the filename must match the canonical form", async () => {
  const { t, storedPath, close } = await setup();
  try {
    const bytes = Buffer.from("tarball");
    const prefixed = await upload(t, bytes, { version: " v0.2.0 ", filename: "relayd-v0.2.0.tar.gz" });
    assert.equal(prefixed.status, 400);
    assert.equal(prefixed.json.error, "invalid_filename");

    const res = await upload(t, bytes, { version: " v0.2.0 " });
    assert.equal(res.status, 200);
    assert.equal(res.json.artifact.version, VERSION);
    assert.equal(res.json.artifact.url, `${PUBLIC_ORIGIN}/relayd/${VERSION}/${FILENAME}`);
    assert.ok(existsSync(storedPath), "the canonical path is the only path written");
  } finally {
    await close();
  }
});

test("a body over the cap is 413 and leaves no partial artifact behind", async () => {
  const { t, artifactDir, storedPath, close } = await setup({
    env: { RELAY_ARTIFACT_MAX_BYTES: "1024" },
  });
  try {
    const res = await upload(t, crypto.randomBytes(1025));
    assert.equal(res.status, 413);
    assert.equal(res.json.error, "body_too_large");
    assert.equal(existsSync(storedPath), false);
    assert.deepEqual(readdirSync(artifactDir), []);

    // The cap is a ceiling, not a size: everything up to it still stores.
    const ok = await upload(t, crypto.randomBytes(1024));
    assert.equal(ok.status, 200);
    assert.equal(ok.json.artifact.bytes, 1024);
  } finally {
    await close();
  }
});

test("re-uploading identical bytes succeeds; different bytes under the same version is 409", async () => {
  const { t, storedPath, close } = await setup();
  try {
    const bytes = crypto.randomBytes(2048);
    const first = await upload(t, bytes);
    assert.equal(first.status, 200);

    // The publisher is reproducible — sorted tar members, fixed mtimes, a
    // builtAt from the commit date — so a retried release rebuilds the same
    // tarball byte for byte. Refusing that would make the ordinary retry after
    // a dropped announcement look like a conflict.
    const again = await upload(t, Buffer.from(bytes));
    assert.equal(again.status, 200);
    assert.deepEqual(again.json.artifact, first.json.artifact);

    const different = await upload(t, crypto.randomBytes(2048));
    assert.equal(different.status, 409);
    assert.equal(different.json.error, "artifact_exists");
    // Immutability is about the BYTES, not the response: the losing upload
    // must not have replaced what nodes are already downloading.
    assert.ok(readFileSync(storedPath).equals(bytes));

    // Not even a one-byte difference, and not a truncation.
    const truncated = await upload(t, bytes.subarray(0, 2047));
    assert.equal(truncated.status, 409);
    assert.ok(readFileSync(storedPath).equals(bytes));
  } finally {
    await close();
  }
});

test("a deployment with no public https base URL refuses to host artifacts rather than storing unannounceable bytes", async () => {
  const { t, artifactDir, close } = await setup({ env: { BETTER_AUTH_URL: "http://127.0.0.1:8790" } });
  try {
    const res = await upload(t, Buffer.from("tarball"));
    assert.equal(res.status, 503);
    assert.equal(res.json.error, "artifact_hosting_unconfigured");
    assert.deepEqual(readdirSync(artifactDir), []);
  } finally {
    await close();
  }
});

test("an artifact directory that cannot be created is its own error code, not an opaque 500", async () => {
  const artifactDir = mkdtempSync(join(tmpdir(), "relay-artifacts-"));
  // A regular file where a directory has to be. Chosen over an unwritable
  // directory because this fails for root too, and CI builds run as root —
  // a permission test that silently passes there tests nothing.
  writeFileSync(join(artifactDir, "blocked"), "");
  const t = await startTestApp({
    env: { BETTER_AUTH_URL: PUBLIC_ORIGIN, RELAY_ARTIFACT_DIR: join(artifactDir, "blocked", "artifacts") },
  });
  try {
    const res = await upload(t, Buffer.from("tarball"));
    assert.equal(res.status, 500);
    assert.equal(res.json.error, "artifact_dir_unwritable");
  } finally {
    await t.close();
    rmSync(artifactDir, { recursive: true, force: true });
  }
});

// ── download ──────────────────────────────────────────────────────────────

test("the public download serves exactly the stored bytes, unauthenticated and immutably cached", async () => {
  const { t, close } = await setup();
  try {
    const bytes = crypto.randomBytes(8192);
    const uploaded = await upload(t, bytes);
    assert.equal(uploaded.status, 200);

    // No authorization header anywhere in this request: a node downloads
    // before it holds anything it could present, and the signature over the
    // digest — not the transport — is what protects the bytes.
    const res = await download(t, `/relayd/${VERSION}/${FILENAME}`);
    assert.equal(res.status, 200);
    assert.ok(res.buf.equals(bytes), "byte-for-byte what was uploaded");
    assert.equal(res.headers.get("content-type"), "application/gzip");
    assert.equal(res.headers.get("content-length"), String(bytes.length));
    // One URL is one tarball forever — a new release is a new version and
    // therefore a new path — so a year of immutable caching is exactly true.
    assert.equal(res.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(
      crypto.createHash("sha256").update(res.buf).digest("hex"),
      uploaded.json.artifact.sha256,
      "the digest the announcement carries is the digest a node computes",
    );
  } finally {
    await close();
  }
});

test("an unknown version, a wrong filename, a non-canonical URL and a traversal are one identical 404", async () => {
  const { t, artifactDir, close } = await setup();
  try {
    await upload(t, crypto.randomBytes(512));
    // Something worth stealing, one directory above what the route serves.
    writeFileSync(join(artifactDir, "secret.txt"), "not yours");

    for (const path of [
      `/relayd/0.3.0/relayd-0.3.0.tar.gz`, // published version, never uploaded
      `/relayd/${VERSION}/relayd-0.3.0.tar.gz`, // filename disagreeing with the version
      `/relayd/${VERSION}/${FILENAME}.sig`,
      `/relayd/v${VERSION}/${FILENAME}`, // a second URL for one cached object
      // Escaped separators survive URL parsing, so these two DO reach the
      // route: the segment is decoded first and then judged, which is why
      // `%2e%2e` is refused by the same rule as `..` rather than sailing past
      // a check that only ever saw the escaped spelling.
      `/relayd/${VERSION}/..%2f..%2fsecret.txt`,
      `/relayd/${VERSION}/%2e%2e%2f%2e%2e%2fsecret.txt`,
      `/relayd/${VERSION}/${encodeURIComponent(`../${VERSION}/${FILENAME}`)}`,
      `/relayd/0.2.0%00/${FILENAME}`,
    ]) {
      const res = await download(t, path);
      assert.equal(res.status, 404, `${path} must not be served`);
      assert.equal(res.json.error, "not_found", path);
      assert.equal(res.buf.includes("not yours"), false, path);
    }

    // No listing at any level of the served prefix, and nothing above it. The
    // last two never reach the route at all — a dot segment, however spelled,
    // is resolved away while the URL is parsed, so the path that gets routed is
    // `/secret.txt` and there is no such route. The assertion is therefore that
    // nothing is served, not which refusal answers.
    for (const path of [
      "/relayd",
      "/relayd/",
      `/relayd/${VERSION}`,
      `/relayd/${VERSION}/`,
      `/relayd/${VERSION}/../secret.txt`,
      `/relayd/%2e%2e/%2e%2e/secret.txt`,
    ]) {
      const res = await download(t, path);
      assert.notEqual(res.status, 200, `${path} must not be served`);
      assert.equal(res.buf.includes(FILENAME), false, path);
      assert.equal(res.buf.includes("not yours"), false, path);
    }
  } finally {
    await close();
  }
});

// ── round trip ────────────────────────────────────────────────────────────

// The whole publish path in one test, because the URL is the seam: the upload
// mints it, the announcement stores it, and a machine acts on whatever comes
// back off the poll. A URL that is right in two of those three places and wrong
// in the third is a fleet downloading nothing, and nothing shorter than this
// notices.
test("upload, announce the returned url, and a node's poll hands back that exact url", async () => {
  const { t, close } = await setup();
  try {
    const session = await signIn(t);
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    t.app.registry.createNode(session.accountId, {
      id: NODE_ID,
      kind: "byo",
      name: "box",
      pubkey: publicKey.export({ type: "spki", format: "pem" }),
    });

    const bytes = crypto.randomBytes(3072);
    const uploaded = await upload(t, bytes);
    assert.equal(uploaded.status, 200);
    const { url, sha256 } = uploaded.json.artifact;

    // The signature covers the digest, not the URL, which is exactly why the
    // artifact can move hosts — from the bucket to here — without re-signing.
    const releaseKey = crypto.generateKeyPairSync("ed25519").privateKey;
    const published = await api(t.baseUrl, "POST", "/v1/admin/relayd-release", {
      body: {
        channel: "stable",
        version: VERSION,
        url,
        sha256,
        sigAlg: "ed25519",
        sig: crypto.sign(null, Buffer.from(sha256, "hex"), releaseKey).toString("base64url"),
        minVersion: "0.1.0",
        notes: null,
      },
      ...adminAuth,
    });
    assert.equal(published.status, 200, JSON.stringify(published.json));

    const pathWithQuery = "/v1/node/handoffs?wait=0";
    t.clock.t += 1;
    const signature = crypto.sign(
      null,
      nodeRequestSigningInput({ method: "GET", pathWithQuery, ts: t.clock.t, nodeId: NODE_ID }),
      privateKey,
    );
    const poll = await api(t.baseUrl, "GET", pathWithQuery, {
      headers: {
        "x-relay-node": NODE_ID,
        "x-relay-ts": String(t.clock.t),
        "x-relay-signature": signature.toString("base64url"),
      },
    });
    assert.equal(poll.status, 200);
    assert.equal(poll.json.release.url, url);
    assert.equal(poll.json.release.sha256, sha256);

    // And that URL is fetchable exactly as announced, against this server.
    const fetched = await download(t, new URL(url).pathname);
    assert.equal(fetched.status, 200);
    assert.ok(fetched.buf.equals(bytes));
  } finally {
    await close();
  }
});
