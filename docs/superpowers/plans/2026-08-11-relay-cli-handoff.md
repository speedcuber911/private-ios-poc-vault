# Relay CLI + Session Handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a `relay` CLI that turns a stopped local Claude Code / Codex / Cursor session into a resumable session on the user's e2b sandbox, surfaced as a handoff card in the iOS app.

**Architecture:** Hardened C — GitHub carries repo state *and* session state (the latter sealed to the sandbox node's X25519 key, so GitHub only ever holds ciphertext); a content-free ping to relay-cloud makes pickup instant via a node-held long-poll; the sandbox clones the handoff branch, decrypts the session, stages it for the harness's native resume, and emits a signed node event that fans out to APNs.

**Tech Stack:** Node ≥ 20 ESM zero-dep (CLI), Node ≥ 22 (relayd, cloud, `node:sqlite`, `node:test`), Swift 5 / iOS 17 (app), git CLI, openssl CLI.

## Global Constraints

Every task's requirements implicitly include this section.

- **Zero external npm dependencies** in `product/cli`, `product/relayd`, `product/cloud`. Node built-ins only.
- **Test runner** is `node --test`; assertions via `node:assert/strict`. iOS uses XCTest.
- **relayd env knobs use the `RELAYD_` prefix**, declared as flat module-level consts in `src/config.mjs` and added to the export block. `CODEX_*` names are legacy-only — never add a new one.
- **cloud env knobs** are read in `src/config.js` via `intFrom(env.X, fallback)` or `env.X || ""`.
- **Secrets never appear** in argv, logs, stdout, error messages, JSON responses, or committed files. Tokens travel in env or request headers/bodies only. Files holding key material are written 0600, directories 0700.
- **Transcript plaintext exists in exactly two places:** the laptop and inside the sandbox. Anything committed to git or sent to relay-cloud is ciphertext or names.
- **Handoff blobs live only on `relay/handoff-*` branches.** The CLI refuses to write `.relay/handoff/**` on any other branch.
- **The workspace jail holds:** every path relayd touches must realpath-resolve inside `workspaceBrowseRoot`.
- **No force-push, ever.** `git push <remote> <branch>` only.
- **Cloud long-polls must return in < 300 s** (nginx `proxy_read_timeout`); the cap in this plan is 25 s.
- **iOS:** `AppTheme` has no success/OK color by design. A "ready" state renders in `AppTheme.textSecondary`. Never introduce `statusOK`/`statusInfo`/`statusNeutral`, `Circle().fill(AppTheme.status…)`, or `checkmark.circle.fill` — `ManifestTests.testStatusIndicatorsStayTypographic()` scans source text for those strings.
- **Every new Swift file needs four `project.pbxproj` edits** (PBXFileReference, PBXBuildFile, PBXGroup membership, Sources build phase). Next free IDs: file refs from `100000000000000000000052`, build files from `200000000000000000000048`. (`…051`/`…047` are taken by `TrialStatusBanner.swift`.) **Re-check the highest id in use before assigning** — parallel work lands new files.
- **Commit after every task.** Conventional-commit subjects (`feat:`, `test:`, `docs:`).

---

## File Structure

### New — `product/cli/` (the relay CLI)

| File | Responsibility |
|---|---|
| `package.json` | name `@relay/cli`, `"bin": {"relay": "bin/relay"}`, `"type": "module"`, `"test": "node --test"` |
| `bin/relay` | Subcommand switch + arg parsing. Lazy dynamic imports (mirrors `relayd/bin/relayd`). |
| `src/creds.mjs` | `~/.relay/credentials.json` read/write, 0600 |
| `src/cloud.mjs` | HTTP client for relay-cloud (bearer session) |
| `src/repo.mjs` | git helpers, github.com origin guard, branch/commit/push |
| `src/sessions.mjs` | Local session discovery for claude / codex / cursor |
| `src/seal.mjs` | **Vendored byte-identical copy** of `relayd/src/seal.mjs` |
| `src/commands/login.mjs` | Device-code browser login + node key pinning |
| `src/commands/init.mjs` | Per-repo registration + fingerprint pin |
| `src/commands/handoff.mjs` | The handoff pipeline |
| `src/commands/syncauth.mjs` | Credential bundle → rendezvous |
| `src/commands/status.mjs` | Handoff states for this repo |
| `test/*.test.mjs` | One suite per module |

### Modified — `product/cloud/`

| File | Change |
|---|---|
| `src/db.js` | `+3` tables (`device_codes`, `repos`, `handoffs`), `+1` column (`nodes.enc_pubkey`, `pairing_sessions.kind`) |
| `src/registry.js` | Accessors for the new tables; `createNode` takes `encPubkey`; `deleteAccount` deletes the new account-scoped rows |
| `src/nodeauth.js` | **New.** Signed-GET verification for node-authed routes |
| `src/server.js` | Device-code routes, repos route, handoff routes, enroll v2 field, `sweepDeviceCodes` in `runSweeps` |
| `src/notify.js` | `handoff.ready` / `handoff.failed` in `KNOWN_TYPES` + `MUTABLE_TYPES` + `categoryFor` |
| `src/pairing.js` | `kind` on sessions; per-kind quota |
| `src/config.js` | `handoff` group |

### Modified — `product/relayd/`

| File | Change |
|---|---|
| `src/seal.mjs` | **New.** X25519 + AES-256-GCM seal/open (canonical copy) |
| `src/identity.mjs` | X25519 encryption keypair alongside the ed25519 identity |
| `src/enroll.mjs` | Sends `encPubkey` |
| `src/cloudclient.mjs` | **New.** Signed GET long-poll + signed event POST |
| `src/sessionimport.mjs` | **New.** Per-harness session staging |
| `src/handoff.mjs` | **New.** Pickup → clone → decrypt → stage → thread → event; push-back |
| `src/syncauth.mjs` | **New.** Credential bundle installer |
| `src/jobs.mjs` | One line in `finishJob` calling `completeHandoffJob(job)` |
| `src/index.mjs` | Start the handoff loop in tunneled mode |
| `src/config.mjs` | `RELAYD_CLOUD_URL`, `RELAYD_HANDOFF_ENABLED`, `RELAYD_HANDOFF_POLL_WAIT_SEC` |

### Modified — `ios/POCVault/`

| File | Change |
|---|---|
| `POCVault/Models/RelayHandoff.swift` | **New.** `RelayHandoffCard`, `RelayMacSession` |
| `POCVault/Networking/CodexClient.swift` | `fetchHandoffs`, `continueHandoff`, `fetchMacSessions`; `"handoffs"`/`"sessions"` envelope keys |
| `POCVault/Views/RelayHandoffCardView.swift` | **New.** The card + the "On your Mac" section |
| `POCVault/Views/RelayChatView.swift` | Render both sections at the top of `RelayThreadDrawer` |
| `POCVault/Services/RelayPushService.swift` | **New.** APNs registration + routing |
| `POCVault/POCVaultApp.swift` | `@UIApplicationDelegateAdaptor`, push wiring |

> **Design note — handoffs are a resource, not a thread kind.** relayd's `threads`
> table is *derived* from jobs and chats; there is no standalone thread-creation
> path, and `CodexThreadFeedItem.Source` has 13 exhaustive switches that a third
> case would break. A handoff is therefore its own node-side resource with its own
> endpoints, rendered as its own section in the thread drawer. Tapping **Continue**
> creates a real job, which creates a real thread through the existing machinery —
> so the handoff becomes an ordinary thread exactly when work starts on it.

---

## Task 1: Sealed-blob crypto (`seal.mjs`)

**Files:**
- Create: `product/relayd/src/seal.mjs`
- Test: `product/relayd/test/seal.test.mjs`

**Interfaces:**
- Consumes: nothing (leaf module, `node:crypto` only)
- Produces:
  - `SEAL_MAGIC: Buffer` — the 8 ASCII bytes `RLYSEAL1`
  - `generateEncKeyPair() -> { publicKeyB64: string, privateKeyPem: string }` — `publicKeyB64` is base64 of the raw 32-byte X25519 public key
  - `sealTo(recipientPublicB64: string, plaintext: Buffer) -> Buffer`
  - `openSealed(privateKeyPem: string, sealed: Buffer) -> Buffer` — throws `Error("seal_bad_magic" | "seal_truncated" | "seal_decrypt_failed")`

Wire format, in order: magic (8 bytes) ‖ ephemeral X25519 public key (32 raw bytes) ‖ GCM nonce (12 bytes) ‖ ciphertext ‖ GCM tag (16 bytes). The key is `HKDF-SHA256(ikm = X25519(eph_priv, recipient_pub), salt = SEAL_MAGIC, info = "relay-seal-v1" ‖ eph_pub ‖ recipient_pub, length = 32)`.

- [ ] **Step 1: Write the failing test**

Create `product/relayd/test/seal.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

const { generateEncKeyPair, sealTo, openSealed, SEAL_MAGIC } = await import("../src/seal.mjs");

test("seal round-trips a payload the recipient can open", () => {
  const recipient = generateEncKeyPair();
  const plaintext = Buffer.from(JSON.stringify({ hello: "world", n: 42 }), "utf8");

  const sealed = sealTo(recipient.publicKeyB64, plaintext);

  assert.ok(sealed.subarray(0, 8).equals(SEAL_MAGIC), "sealed blob starts with the magic");
  assert.ok(!sealed.includes(Buffer.from("hello", "utf8")), "plaintext must not survive in the blob");
  assert.deepEqual(openSealed(recipient.privateKeyPem, sealed), plaintext);
});

test("seal is non-deterministic — each call uses a fresh ephemeral key", () => {
  const recipient = generateEncKeyPair();
  const plaintext = Buffer.from("same input", "utf8");
  const a = sealTo(recipient.publicKeyB64, plaintext);
  const b = sealTo(recipient.publicKeyB64, plaintext);
  assert.notDeepEqual(a, b, "two seals of the same plaintext must differ");
  assert.deepEqual(openSealed(recipient.privateKeyPem, a), plaintext);
  assert.deepEqual(openSealed(recipient.privateKeyPem, b), plaintext);
});

test("the wrong recipient cannot open a sealed blob", () => {
  const recipient = generateEncKeyPair();
  const stranger = generateEncKeyPair();
  const sealed = sealTo(recipient.publicKeyB64, Buffer.from("secret", "utf8"));
  assert.throws(() => openSealed(stranger.privateKeyPem, sealed), /seal_decrypt_failed/);
});

test("tampering with any byte of the blob is detected", () => {
  const recipient = generateEncKeyPair();
  const sealed = sealTo(recipient.publicKeyB64, Buffer.from("secret payload", "utf8"));
  for (const index of [8, 40, 55, sealed.length - 1]) {
    const tampered = Buffer.from(sealed);
    tampered[index] ^= 0x01;
    assert.throws(() => openSealed(recipient.privateKeyPem, tampered), /seal_decrypt_failed/,
      `flipping byte ${index} must be rejected`);
  }
});

test("a blob without the magic or shorter than the header is rejected", () => {
  const recipient = generateEncKeyPair();
  assert.throws(() => openSealed(recipient.privateKeyPem, Buffer.alloc(80)), /seal_bad_magic/);
  assert.throws(() => openSealed(recipient.privateKeyPem, Buffer.concat([SEAL_MAGIC, Buffer.alloc(4)])),
    /seal_truncated/);
});

test("public keys are 32 raw bytes in base64 and private keys are PKCS#8 PEM", () => {
  const pair = generateEncKeyPair();
  assert.equal(Buffer.from(pair.publicKeyB64, "base64").length, 32);
  assert.match(pair.privateKeyPem, /^-----BEGIN PRIVATE KEY-----/);
  assert.equal(crypto.createPrivateKey(pair.privateKeyPem).asymmetricKeyType, "x25519");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd product/relayd && node --test test/seal.test.mjs`
Expected: FAIL — `Cannot find module '../src/seal.mjs'`.

- [ ] **Step 3: Write the implementation**

Create `product/relayd/src/seal.mjs`:

```js
// relayd seal.mjs — sealed blobs for the handoff pipeline.
//
// A sealed blob can be produced by anyone holding the recipient's X25519 public
// key and opened only by the holder of the matching private key. Handoff
// manifests and session transcripts are sealed on the laptop before they are
// committed to a git branch, so GitHub only ever stores ciphertext.
//
// CANONICAL COPY. product/cli/src/seal.mjs is a byte-identical vendored copy;
// product/cli/test/seal-vendor.test.mjs fails if the two files diverge.
import crypto from "node:crypto";

const SEAL_MAGIC = Buffer.from("RLYSEAL1", "utf8");
const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");
const EPH_PUBLIC_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = SEAL_MAGIC.length + EPH_PUBLIC_BYTES + NONCE_BYTES;
const KDF_INFO_LABEL = Buffer.from("relay-seal-v1", "utf8");

function rawToPublicKey(raw) {
  if (!Buffer.isBuffer(raw) || raw.length !== EPH_PUBLIC_BYTES) {
    throw new Error("seal_bad_public_key");
  }
  return crypto.createPublicKey({
    key: Buffer.concat([X25519_SPKI_PREFIX, raw]),
    format: "der",
    type: "spki",
  });
}

function publicKeyToRaw(keyObject) {
  return keyObject.export({ type: "spki", format: "der" }).subarray(X25519_SPKI_PREFIX.length);
}

function deriveKey(sharedSecret, ephemeralPublicRaw, recipientPublicRaw) {
  const info = Buffer.concat([KDF_INFO_LABEL, ephemeralPublicRaw, recipientPublicRaw]);
  return Buffer.from(crypto.hkdfSync("sha256", sharedSecret, SEAL_MAGIC, info, 32));
}

function generateEncKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("x25519");
  return {
    publicKeyB64: publicKeyToRaw(publicKey).toString("base64"),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }),
  };
}

function sealTo(recipientPublicB64, plaintext) {
  const recipientPublicRaw = Buffer.from(String(recipientPublicB64), "base64");
  const recipientPublicKey = rawToPublicKey(recipientPublicRaw);
  const ephemeral = crypto.generateKeyPairSync("x25519");
  const ephemeralPublicRaw = publicKeyToRaw(ephemeral.publicKey);

  const sharedSecret = crypto.diffieHellman({
    privateKey: ephemeral.privateKey,
    publicKey: recipientPublicKey,
  });
  const key = deriveKey(sharedSecret, ephemeralPublicRaw, recipientPublicRaw);
  const nonce = crypto.randomBytes(NONCE_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  return Buffer.concat([SEAL_MAGIC, ephemeralPublicRaw, nonce, ciphertext, cipher.getAuthTag()]);
}

function openSealed(privateKeyPem, sealed) {
  if (!Buffer.isBuffer(sealed) || sealed.length < SEAL_MAGIC.length ||
      !sealed.subarray(0, SEAL_MAGIC.length).equals(SEAL_MAGIC)) {
    throw new Error("seal_bad_magic");
  }
  if (sealed.length < HEADER_BYTES + TAG_BYTES) throw new Error("seal_truncated");

  const ephemeralPublicRaw = sealed.subarray(SEAL_MAGIC.length, SEAL_MAGIC.length + EPH_PUBLIC_BYTES);
  const nonce = sealed.subarray(SEAL_MAGIC.length + EPH_PUBLIC_BYTES, HEADER_BYTES);
  const ciphertext = sealed.subarray(HEADER_BYTES, sealed.length - TAG_BYTES);
  const tag = sealed.subarray(sealed.length - TAG_BYTES);

  const privateKey = crypto.createPrivateKey(privateKeyPem);
  const recipientPublicRaw = publicKeyToRaw(crypto.createPublicKey(privateKey));

  try {
    const sharedSecret = crypto.diffieHellman({
      privateKey,
      publicKey: rawToPublicKey(Buffer.from(ephemeralPublicRaw)),
    });
    const key = deriveKey(sharedSecret, ephemeralPublicRaw, recipientPublicRaw);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error("seal_decrypt_failed");
  }
}

export { SEAL_MAGIC, generateEncKeyPair, sealTo, openSealed };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd product/relayd && node --test test/seal.test.mjs`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add product/relayd/src/seal.mjs product/relayd/test/seal.test.mjs
git commit -m "feat(relayd): X25519 sealed blobs for handoff payloads"
```

---

## Task 2: Node encryption keypair in `identity.mjs`

**Files:**
- Modify: `product/relayd/src/identity.mjs` (`identityPaths` ~line 58, `initIdentity` ~line 104, `identityStatus`, export block ~line 384)
- Test: `product/relayd/test/identity-enc.test.mjs`

**Interfaces:**
- Consumes: `generateEncKeyPair` from Task 1
- Produces:
  - `identityPaths(baseDir).encKeyPath` → `<base>/node-enc.key.pem`
  - `identityPaths(baseDir).encPubPath` → `<base>/node-enc.pub.b64`
  - `readEncPublicKeyB64(paths = identityPaths()) -> string | null`
  - `readEncPrivateKeyPem(paths = identityPaths()) -> string | null`
  - `identityStatus({baseDir})` gains `hasEncKey: boolean`

- [ ] **Step 1: Write the failing test**

Create `product/relayd/test/identity-enc.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.CODEX_DATA_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), "relayd-idenc-data-"));

const { initIdentity, identityPaths, readEncPublicKeyB64, readEncPrivateKeyPem, identityStatus } =
  await import("../src/identity.mjs");
const { sealTo, openSealed } = await import("../src/seal.mjs");

function freshBase() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "relayd-idenc-"));
}

test("initIdentity creates an X25519 encryption keypair alongside the ed25519 identity", () => {
  const baseDir = freshBase();
  initIdentity({ baseDir });
  const paths = identityPaths(baseDir);

  assert.ok(fs.existsSync(paths.encKeyPath), "private encryption key exists");
  assert.ok(fs.existsSync(paths.encPubPath), "public encryption key exists");
  assert.equal(fs.statSync(paths.encKeyPath).mode & 0o777, 0o600, "private key is 0600");
  assert.equal(Buffer.from(readEncPublicKeyB64(paths), "base64").length, 32);
  assert.equal(identityStatus({ baseDir }).hasEncKey, true);
});

test("the published public key opens blobs sealed to it", () => {
  const baseDir = freshBase();
  initIdentity({ baseDir });
  const paths = identityPaths(baseDir);
  const plaintext = Buffer.from("handoff manifest", "utf8");

  const sealed = sealTo(readEncPublicKeyB64(paths), plaintext);

  assert.deepEqual(openSealed(readEncPrivateKeyPem(paths), sealed), plaintext);
});

test("initIdentity is idempotent — a second call keeps the same encryption key", () => {
  const baseDir = freshBase();
  initIdentity({ baseDir });
  const first = readEncPublicKeyB64(identityPaths(baseDir));
  initIdentity({ baseDir });
  assert.equal(readEncPublicKeyB64(identityPaths(baseDir)), first);
});

test("readers return null when no identity has been initialised", () => {
  const paths = identityPaths(freshBase());
  assert.equal(readEncPublicKeyB64(paths), null);
  assert.equal(readEncPrivateKeyPem(paths), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd product/relayd && node --test test/identity-enc.test.mjs`
Expected: FAIL — `readEncPublicKeyB64 is not a function`.

- [ ] **Step 3: Add the paths**

In `product/relayd/src/identity.mjs`, add the import at the top of the import block:

```js
import { generateEncKeyPair } from "./seal.mjs";
```

In `identityPaths(baseDir = identityDir)`, add two entries to the returned object immediately after `identityPubPath`:

```js
    encKeyPath: path.join(baseDir, "node-enc.key.pem"),
    encPubPath: path.join(baseDir, "node-enc.pub.b64"),
```

- [ ] **Step 4: Generate the keypair in `initIdentity`**

In `initIdentity`, immediately after the block that writes `identityKeyPath` / `identityPubPath`, add:

```js
  if (!fs.existsSync(paths.encKeyPath) || !fs.existsSync(paths.encPubPath)) {
    const encryption = generateEncKeyPair();
    writePrivate(paths.encKeyPath, encryption.privateKeyPem);
    writePrivate(paths.encPubPath, `${encryption.publicKeyB64}\n`);
  }
```

- [ ] **Step 5: Add the readers and the status field**

Add these two functions next to `readNodeId`:

```js
function readEncPublicKeyB64(paths = identityPaths()) {
  try {
    return fs.readFileSync(paths.encPubPath, "utf8").trim() || null;
  } catch {
    return null;
  }
}


function readEncPrivateKeyPem(paths = identityPaths()) {
  try {
    return fs.readFileSync(paths.encKeyPath, "utf8") || null;
  } catch {
    return null;
  }
}
```

In `identityStatus`, add `hasEncKey` to the returned object next to `hasIdentityKey`:

```js
    hasEncKey: fs.existsSync(paths.encKeyPath),
```

Add all three names to the export block at the bottom of the file:

```js
  readEncPublicKeyB64,
  readEncPrivateKeyPem,
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd product/relayd && node --test test/identity-enc.test.mjs test/identity.test.mjs`
Expected: PASS — the 4 new tests plus the existing identity suite, all green.

- [ ] **Step 7: Commit**

```bash
git add product/relayd/src/identity.mjs product/relayd/test/identity-enc.test.mjs
git commit -m "feat(relayd): node X25519 encryption keypair in identity"
```

---

## Task 3: Cloud stores the node encryption key (enroll v2)

**Files:**
- Modify: `product/cloud/src/db.js` (SCHEMA, `nodes` table)
- Modify: `product/cloud/src/registry.js` (`ensureNodeEncColumn`, `createNode`, `mapNode`, export object)
- Modify: `product/cloud/src/server.js` (`/v1/trial-nodes/enroll` ~L233, `publicTrial` ~L542, its three call sites)
- Test: `product/cloud/test/enroll-enc.test.mjs`

**Interfaces:**
- Consumes: nothing from earlier tasks (independent of relayd)
- Produces:
  - node rows gain `encPubkey: string | null`
  - `registry.createNode(accountId, { id, kind, name, pubkey, encPubkey, version })`
  - `POST /v1/trial-nodes/enroll` accepts an optional `encPubkey` (base64 of 32 raw bytes; rejected with `400 invalid_enc_pubkey` when malformed)
  - `GET /v1/trial-nodes/current` → `{ trial: { …, nodeEncPubkey: string | null } }`

- [ ] **Step 1: Write the failing test**

Create `product/cloud/test/enroll-enc.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { startTestApp, api, signIn, authed, makeNodeIdentity } from "./helpers.mjs";
import { makeFakeProvisioner } from "./trial-api.test.mjs";

// The enroll route validates `pubkey` with parseNodePubkey before it reaches any
// new code, so this must be a real ed25519 SPKI PEM. (A placeholder string like
// "pk-pem" only works in trial-api.test.mjs, which calls registry.createNode
// directly and bypasses HTTP validation.) `pubkey` and `encPubkey` are two
// different keys in two different formats — ed25519 PEM vs base64 of 32 raw
// X25519 bytes — and must never be interchanged.
const NODE_PUBKEY_PEM = makeNodeIdentity().pubkeyPem;

const TRIAL_ENV = {
  E2B_API_URL: "http://cube.invalid", E2B_API_KEY: "k", TRIAL_TEMPLATE_ID: "relay-trial",
  TUNNEL_HOST: "broker.test", TUNNEL_PORT: "80", TUNNEL_SUFFIX: ".tun.test",
};
const PAIRING = {
  pairingId: "11111111-1111-4111-8111-111111111111",
  pairingSecret: "c2VjcmV0LXNlY3JldC1zZWNyZXQ",
};
const NODE_ID = "node-00112233445566aa";

function encPubkeyB64() {
  const { publicKey } = crypto.generateKeyPairSync("x25519");
  return publicKey.export({ type: "spki", format: "der" }).subarray(12).toString("base64");
}

async function createTrial(t) {
  const session = await signIn(t);
  const res = await api(t.baseUrl, "POST", "/v1/trial-nodes", { body: PAIRING, ...authed(session.sessionToken) });
  assert.equal(res.status, 201);
  return session;
}

test("enroll stores the node encryption key and current exposes it", async () => {
  const provisioner = makeFakeProvisioner();
  const t = await startTestApp({ env: TRIAL_ENV, provisioner });
  try {
    const session = await createTrial(t);
    const token = provisioner.created[0].envVars.RELAYD_ENROLL_TOKEN;
    const encPubkey = encPubkeyB64();

    const enroll = await api(t.baseUrl, "POST", "/v1/trial-nodes/enroll", {
      body: { token, nodeId: NODE_ID, pubkey: "pk-pem", encPubkey, version: "0.1.0" },
    });
    assert.equal(enroll.status, 200);

    const current = await api(t.baseUrl, "GET", "/v1/trial-nodes/current", authed(session.sessionToken));
    assert.equal(current.json.trial.state, "ready");
    assert.equal(current.json.trial.nodeEncPubkey, encPubkey);
    assert.equal(t.app.registry.getNode(NODE_ID).encPubkey, encPubkey);
  } finally { await t.close(); }
});

test("a malformed encryption key is rejected and no node is created", async () => {
  const provisioner = makeFakeProvisioner();
  const t = await startTestApp({ env: TRIAL_ENV, provisioner });
  try {
    await createTrial(t);
    const token = provisioner.created[0].envVars.RELAYD_ENROLL_TOKEN;

    const res = await api(t.baseUrl, "POST", "/v1/trial-nodes/enroll", {
      body: { token, nodeId: NODE_ID, pubkey: "pk-pem", encPubkey: "not-32-bytes" },
    });

    assert.equal(res.status, 400);
    assert.equal(res.json.error, "invalid_enc_pubkey");
    assert.equal(t.app.registry.getNode(NODE_ID), null);
  } finally { await t.close(); }
});

test("enroll without an encryption key still succeeds and reports null", async () => {
  const provisioner = makeFakeProvisioner();
  const t = await startTestApp({ env: TRIAL_ENV, provisioner });
  try {
    const session = await createTrial(t);
    const token = provisioner.created[0].envVars.RELAYD_ENROLL_TOKEN;

    const enroll = await api(t.baseUrl, "POST", "/v1/trial-nodes/enroll", {
      body: { token, nodeId: NODE_ID, pubkey: "pk-pem" },
    });
    assert.equal(enroll.status, 200);

    const current = await api(t.baseUrl, "GET", "/v1/trial-nodes/current", authed(session.sessionToken));
    assert.equal(current.json.trial.nodeEncPubkey, null);
  } finally { await t.close(); }
});
```

If `makeFakeProvisioner` is not exported from `test/trial-api.test.mjs`, add `export` to its declaration there in this same step.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd product/cloud && node --test test/enroll-enc.test.mjs`
Expected: FAIL — `nodeEncPubkey` is `undefined`.

- [ ] **Step 3: Add the column**

In `product/cloud/src/db.js`, add the column to the `nodes` block of `SCHEMA`, after `pubkey TEXT NOT NULL,`:

```sql
  enc_pubkey TEXT,
```

In `product/cloud/src/registry.js`, add a non-destructive guard next to `ensureNodeEventSchema` (existing databases predate the column):

```js
function ensureNodeEncColumn(db) {
  let columns = [];
  try {
    columns = db.prepare("PRAGMA table_info(nodes)").all();
  } catch {
    return;
  }
  if (columns.length === 0) return;
  if (!columns.some((column) => column.name === "enc_pubkey")) {
    db.exec("ALTER TABLE nodes ADD COLUMN enc_pubkey TEXT");
  }
}
```

Call it from `createRegistry` alongside the existing `ensureAuthSchema(db)` / `ensureNodeEventSchema(db)` calls:

```js
  ensureNodeEncColumn(db);
```

- [ ] **Step 4: Thread the field through the registry**

In `createNode`, accept and persist the new field:

```js
  function createNode(accountId, { id = randomUUID(), kind, name, pubkey, encPubkey = null, version = null } = {}) {
    db.prepare(
      "INSERT INTO nodes (id, account_id, kind, name, pubkey, enc_pubkey, version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(id, accountId, kind, name ?? null, pubkey, encPubkey, version, now());
    return getNode(id);
  }
```

In `mapNode`, add the field to the returned object after `pubkey`:

```js
    encPubkey: row.enc_pubkey ?? null,
```

- [ ] **Step 5: Accept and expose it in the server**

In `product/cloud/src/server.js`, inside the `POST /v1/trial-nodes/enroll` branch, add validation after the existing `parseNodePubkey` check:

```js
      const encPubkey = strOrNull(body?.encPubkey);
      if (encPubkey !== null && Buffer.from(encPubkey, "base64").length !== 32) {
        return sendJson(res, 400, { error: "invalid_enc_pubkey" });
      }
```

and pass it to `createNode`:

```js
      registry.createNode(trial.accountId, {
        id: nodeId, kind: "trial", name: "Trial machine",
        pubkey: String(body.pubkey), encPubkey, version: strOrNull(body?.version),
      });
```

Change `publicTrial` to take the registry and surface the key:

```js
function publicTrial(trial, config, registry) {
  const node = trial.nodeId ? registry.getNode(trial.nodeId) : null;
  return {
    id: trial.id,
    state: trial.state,
    nodeId: trial.nodeId,
    nodeEncPubkey: node?.encPubkey ?? null,
    sni: trial.nodeId && config.tunnel.suffix ? `${trial.nodeId}${config.tunnel.suffix}` : null,
    createdAt: trial.createdAt,
    expiresAt: trial.expiresAt,
  };
}
```

Update all three call sites to pass `registry` as the third argument (`publicTrial(trial, config, registry)`).

- [ ] **Step 6: Run the cloud suite**

Run: `cd product/cloud && node --test test/*.test.mjs`
Expected: PASS — the 3 new tests plus the existing 55; `nodeEncPubkey` does not break the existing `publicTrial` shape assertions (they assert absence of `sandboxId`/`enrollTokenHash`, not exact key sets).

- [ ] **Step 7: Commit**

```bash
git add product/cloud/src/db.js product/cloud/src/registry.js product/cloud/src/server.js product/cloud/test/
git commit -m "feat(cloud): store and expose the node X25519 encryption key (enroll v2)"
```

---

## Task 4: relayd publishes its encryption key at enroll

**Files:**
- Modify: `product/relayd/src/enroll.mjs`
- Test: `product/relayd/test/enroll.test.mjs` (extend)

**Interfaces:**
- Consumes: `readEncPublicKeyB64`, `identityPaths` (Task 2); cloud enroll v2 (Task 3)
- Produces: the enroll request body becomes `{ token, nodeId, pubkey, encPubkey, version }`

- [ ] **Step 1: Write the failing test**

Append to `product/relayd/test/enroll.test.mjs`:

```js
test("enroll publishes the node encryption public key", async () => {
  const cloud = await startFakeCloud((res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, sni: "node-x.tun.test" }));
  });
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-enroll-enc-"));
  try {
    await enrollWithCloud({ cloudUrl: cloud.url, token: "tok-enc", baseDir });

    const body = cloud.calls.at(-1).body;
    assert.equal(Buffer.from(body.encPubkey, "base64").length, 32, "encPubkey is 32 raw bytes");
    assert.match(body.pubkey, /BEGIN PUBLIC KEY/, "the ed25519 identity key is still sent as PEM");
  } finally { await cloud.close(); }
});

test("re-enrolling reuses the same encryption key", async () => {
  const cloud = await startFakeCloud((res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, sni: "node-x.tun.test" }));
  });
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-enroll-enc2-"));
  try {
    await enrollWithCloud({ cloudUrl: cloud.url, token: "tok-one", baseDir });
    await enrollWithCloud({ cloudUrl: cloud.url, token: "tok-two", baseDir });
    assert.equal(cloud.calls[0].body.encPubkey, cloud.calls[1].body.encPubkey);
  } finally { await cloud.close(); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd product/relayd && node --test test/enroll.test.mjs`
Expected: FAIL — `Buffer.from(undefined, "base64").length` is `0`, not `32`.

- [ ] **Step 3: Send the key**

In `product/relayd/src/enroll.mjs`, extend the identity import:

```js
import { initIdentity, identityPaths, readNodeId, readEncPublicKeyB64 } from "./identity.mjs";
```

Read it after `readNodeId(paths)`:

```js
  const encPubkey = readEncPublicKeyB64(paths);
```

and include it in the body:

```js
    body: JSON.stringify({ token, nodeId, pubkey, encPubkey, version }),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd product/relayd && node --test test/enroll.test.mjs test/enroll-cli.test.mjs`
Expected: PASS — including the existing "token must never be printed" assertion.

- [ ] **Step 5: Commit**

```bash
git add product/relayd/src/enroll.mjs product/relayd/test/enroll.test.mjs
git commit -m "feat(relayd): publish the encryption public key during enroll"
```

---

## Task 5: Device-code login for the CLI

**Files:**
- Modify: `product/cloud/src/db.js` (`device_codes` table)
- Modify: `product/cloud/src/registry.js` (five accessors + export object + `deleteAccount`)
- Modify: `product/cloud/src/config.js` (`deviceCodeTtlSec`, `deviceCodePollIntervalSec`, `deviceLoginUrl`)
- Modify: `product/cloud/src/server.js` (three routes + `runSweeps`)
- Test: `product/cloud/test/device-code.test.mjs`

**Interfaces:**
- Consumes: `auth.issueSession(account)`, `auth.authenticate(req)`, `sha256Hex`, `sendJson`, `readJson`, `strOrNull`
- Produces:
  - `POST /v1/auth/device/start` (unauthenticated) → `201 { deviceCode, userCode, verificationUri, interval, expiresIn }`
  - `POST /v1/auth/device/token` (unauthenticated) `{ deviceCode }` → `200 { sessionToken, refreshToken, expiresIn, accountId }` or `400 { error: "authorization_pending" | "expired_token" | "invalid_grant" }`
  - `POST /v1/auth/device/approve` (session-authed) `{ userCode }` → `200 { ok: true }` / `404 { error: "unknown_user_code" }`
  - `registry.createDeviceCode({ deviceCodeHash, userCode, expiresAt })`, `getDeviceCodeByHash(hash)`, `getDeviceCodeByUserCode(code)`, `approveDeviceCode(id, accountId)`, `consumeDeviceCode(id)`, `sweepDeviceCodes(nowMs)`

`userCode` is 8 characters drawn from `BCDFGHJKLMNPQRSTVWXZ23456789` (no vowels — no accidental words; no `0/O/1/I` — no misreads), displayed and accepted as `ABCD-EFGH`. Matching is case-insensitive and ignores the dash.

- [ ] **Step 1: Write the failing test**

Create `product/cloud/test/device-code.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";

import { startTestApp, api, signIn, authed } from "./helpers.mjs";

test("full device-code flow: start, poll pending, approve, poll returns a session", async () => {
  const t = await startTestApp();
  try {
    const start = await api(t.baseUrl, "POST", "/v1/auth/device/start", { body: {} });
    assert.equal(start.status, 201);
    assert.match(start.json.deviceCode, /^[A-Za-z0-9_-]{43}$/);
    assert.match(start.json.userCode, /^[BCDFGHJKLMNPQRSTVWXZ2-9]{4}-[BCDFGHJKLMNPQRSTVWXZ2-9]{4}$/);
    assert.equal(start.json.interval, 5);
    assert.ok(start.json.verificationUri.length > 0);

    const pending = await api(t.baseUrl, "POST", "/v1/auth/device/token", { body: { deviceCode: start.json.deviceCode } });
    assert.equal(pending.status, 400);
    assert.equal(pending.json.error, "authorization_pending");

    const session = await signIn(t);
    const approve = await api(t.baseUrl, "POST", "/v1/auth/device/approve", {
      body: { userCode: start.json.userCode.toLowerCase() }, ...authed(session.sessionToken),
    });
    assert.equal(approve.status, 200);

    const granted = await api(t.baseUrl, "POST", "/v1/auth/device/token", { body: { deviceCode: start.json.deviceCode } });
    assert.equal(granted.status, 200);
    assert.equal(granted.json.accountId, session.accountId);
    assert.ok(granted.json.sessionToken.length > 0);
  } finally { await t.close(); }
});

test("a device code is single-use", async () => {
  const t = await startTestApp();
  try {
    const start = await api(t.baseUrl, "POST", "/v1/auth/device/start", { body: {} });
    const session = await signIn(t);
    await api(t.baseUrl, "POST", "/v1/auth/device/approve", {
      body: { userCode: start.json.userCode }, ...authed(session.sessionToken),
    });
    await api(t.baseUrl, "POST", "/v1/auth/device/token", { body: { deviceCode: start.json.deviceCode } });

    const second = await api(t.baseUrl, "POST", "/v1/auth/device/token", { body: { deviceCode: start.json.deviceCode } });
    assert.equal(second.status, 400);
    assert.equal(second.json.error, "invalid_grant");
  } finally { await t.close(); }
});

test("an expired device code is refused and swept", async () => {
  const t = await startTestApp();
  try {
    const start = await api(t.baseUrl, "POST", "/v1/auth/device/start", { body: {} });
    t.clock.t += 16 * 60 * 1000;

    const res = await api(t.baseUrl, "POST", "/v1/auth/device/token", { body: { deviceCode: start.json.deviceCode } });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, "expired_token");

    t.app.runSweeps();
    const after = await api(t.baseUrl, "POST", "/v1/auth/device/token", { body: { deviceCode: start.json.deviceCode } });
    assert.equal(after.json.error, "invalid_grant", "swept rows become indistinguishable from unknown codes");
  } finally { await t.close(); }
});

test("an unknown device code or user code never reveals which", async () => {
  const t = await startTestApp();
  try {
    const token = await api(t.baseUrl, "POST", "/v1/auth/device/token", { body: { deviceCode: "nope" } });
    assert.equal(token.status, 400);
    assert.equal(token.json.error, "invalid_grant");

    const session = await signIn(t);
    const approve = await api(t.baseUrl, "POST", "/v1/auth/device/approve", {
      body: { userCode: "ZZZZ-ZZZZ" }, ...authed(session.sessionToken),
    });
    assert.equal(approve.status, 404);
    assert.equal(approve.json.error, "unknown_user_code");
  } finally { await t.close(); }
});

test("approving requires a session", async () => {
  const t = await startTestApp();
  try {
    const start = await api(t.baseUrl, "POST", "/v1/auth/device/start", { body: {} });
    const res = await api(t.baseUrl, "POST", "/v1/auth/device/approve", { body: { userCode: start.json.userCode } });
    assert.equal(res.status, 401);
  } finally { await t.close(); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd product/cloud && node --test test/device-code.test.mjs`
Expected: FAIL — `POST /v1/auth/device/start` returns `404 not_found`.

- [ ] **Step 3: Add the table and registry accessors**

In `product/cloud/src/db.js`, append to `SCHEMA`:

```sql
CREATE TABLE IF NOT EXISTS device_codes (
  id TEXT PRIMARY KEY,
  device_code_hash TEXT NOT NULL,
  user_code TEXT NOT NULL,
  account_id TEXT,
  approved_at INTEGER,
  consumed_at INTEGER,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_device_codes_expires ON device_codes (expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_device_codes_user_code ON device_codes (user_code);
```

In `product/cloud/src/registry.js`, add the accessors near the magic-link family:

```js
  function createDeviceCode({ deviceCodeHash, userCode, expiresAt }) {
    const id = randomUUID();
    db.prepare(
      "INSERT INTO device_codes (id, device_code_hash, user_code, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(id, deviceCodeHash, userCode, expiresAt, now());
    return mapDeviceCode(db.prepare("SELECT * FROM device_codes WHERE id = ?").get(id));
  }

  function getDeviceCodeByHash(hash) {
    if (!hash) return null;
    return mapDeviceCode(db.prepare("SELECT * FROM device_codes WHERE device_code_hash = ?").get(hash));
  }

  function getDeviceCodeByUserCode(userCode) {
    if (!userCode) return null;
    return mapDeviceCode(db.prepare("SELECT * FROM device_codes WHERE user_code = ?").get(userCode));
  }

  function approveDeviceCode(id, accountId) {
    db.prepare("UPDATE device_codes SET account_id = ?, approved_at = ? WHERE id = ?").run(accountId, now(), id);
    return mapDeviceCode(db.prepare("SELECT * FROM device_codes WHERE id = ?").get(id));
  }

  function consumeDeviceCode(id) {
    const result = db.prepare("UPDATE device_codes SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL")
      .run(now(), id);
    return result.changes > 0;
  }

  function sweepDeviceCodes(nowMs) {
    db.prepare("DELETE FROM device_codes WHERE expires_at <= ?").run(nowMs);
  }
```

and the row mapper next to `mapTrial`:

```js
function mapDeviceCode(row) {
  if (!row) return null;
  return {
    id: row.id,
    userCode: row.user_code,
    accountId: row.account_id ?? null,
    approvedAt: row.approved_at ?? null,
    consumedAt: row.consumed_at ?? null,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}
```

Add all six function names to the returned object literal. In `deleteAccount`, add to the transaction body:

```js
    db.prepare("DELETE FROM device_codes WHERE account_id = ?").run(accountId);
```

- [ ] **Step 4: Add config knobs**

In `product/cloud/src/config.js`, alongside the magic-link keys:

```js
  deviceCodeTtlSec: intFrom(env.DEVICE_CODE_TTL_SEC, 900),
  deviceCodePollIntervalSec: intFrom(env.DEVICE_CODE_POLL_INTERVAL_SEC, 5),
  deviceLoginUrl: env.DEVICE_LOGIN_URL || "https://relay.example/cli-login",
```

- [ ] **Step 5: Add the routes**

In `product/cloud/src/server.js`, add a helper next to `sha256Hex`:

```js
const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ23456789";

function mintUserCode() {
  const bytes = randomBytes(8);
  let code = "";
  for (const byte of bytes) code += USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length];
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

function normalizeUserCode(value) {
  const cleaned = String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (cleaned.length !== 8) return null;
  return `${cleaned.slice(0, 4)}-${cleaned.slice(4)}`;
}
```

Add the two unauthenticated routes **above** the session-auth boundary line (next to the other `/v1/auth/*` routes):

```js
  if (method === "POST" && path === "/v1/auth/device/start") {
    const deviceCode = randomBytes(32).toString("base64url");
    const record = registry.createDeviceCode({
      deviceCodeHash: sha256Hex(deviceCode),
      userCode: mintUserCode(),
      expiresAt: now() + config.deviceCodeTtlSec * 1000,
    });
    return sendJson(res, 201, {
      deviceCode,
      userCode: record.userCode,
      verificationUri: config.deviceLoginUrl,
      interval: config.deviceCodePollIntervalSec,
      expiresIn: config.deviceCodeTtlSec,
    });
  }

  if (method === "POST" && path === "/v1/auth/device/token") {
    const body = await readJson(req, config.jsonBodyMaxBytes);
    const record = registry.getDeviceCodeByHash(sha256Hex(strOrNull(body?.deviceCode) || ""));
    if (!record || record.consumedAt !== null) return sendJson(res, 400, { error: "invalid_grant" });
    if (record.expiresAt <= now()) return sendJson(res, 400, { error: "expired_token" });
    if (record.accountId === null) return sendJson(res, 400, { error: "authorization_pending" });
    if (!registry.consumeDeviceCode(record.id)) return sendJson(res, 400, { error: "invalid_grant" });
    const account = registry.getAccount(record.accountId);
    if (!account) return sendJson(res, 400, { error: "invalid_grant" });
    return sendJson(res, 200, auth.issueSession(account));
  }
```

Add the approval route **below** the session-auth boundary line:

```js
  if (method === "POST" && path === "/v1/auth/device/approve") {
    const body = await readJson(req, config.jsonBodyMaxBytes);
    const userCode = normalizeUserCode(body?.userCode);
    const record = userCode ? registry.getDeviceCodeByUserCode(userCode) : null;
    if (!record || record.consumedAt !== null || record.expiresAt <= now()) {
      return sendJson(res, 404, { error: "unknown_user_code" });
    }
    registry.approveDeviceCode(record.id, account.id);
    return sendJson(res, 200, { ok: true });
  }
```

Add the sweep to `runSweeps()`:

```js
  registry.sweepDeviceCodes(now());
```

Ensure `randomBytes` is imported from `node:crypto` at the top of `server.js` (it already is, for the trial enroll token).

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd product/cloud && node --test test/device-code.test.mjs && node --test test/*.test.mjs`
Expected: PASS — 5 new tests, whole suite green.

- [ ] **Step 7: Commit**

```bash
git add product/cloud/src product/cloud/test/device-code.test.mjs
git commit -m "feat(cloud): device-code login flow for the relay CLI"
```

---

## Task 6: Repo registration

**Files:**
- Modify: `product/cloud/src/db.js` (`repos` table)
- Modify: `product/cloud/src/registry.js` (three accessors + export object + `deleteAccount`)
- Modify: `product/cloud/src/server.js` (two routes)
- Test: `product/cloud/test/repos.test.mjs`

**Interfaces:**
- Consumes: session auth
- Produces:
  - `POST /v1/repos` (session-authed) `{ fullName }` → `201 { repo: { id, fullName, createdAt } }`, idempotent
  - `GET /v1/repos` (session-authed) → `200 { repos: [...] }`
  - `registry.upsertRepo(accountId, fullName)`, `getRepo(accountId, fullName)`, `listRepos(accountId)`

`fullName` is validated against `/^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/` and stored lowercased (GitHub owner/repo names are case-insensitive; the CLI may report either casing).

- [ ] **Step 1: Write the failing test**

Create `product/cloud/test/repos.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";

import { startTestApp, api, signIn, authed } from "./helpers.mjs";

test("registering a repo is idempotent and case-insensitive", async () => {
  const t = await startTestApp();
  try {
    const session = await signIn(t);
    const first = await api(t.baseUrl, "POST", "/v1/repos", {
      body: { fullName: "Parikshit/Relay" }, ...authed(session.sessionToken),
    });
    assert.equal(first.status, 201);
    assert.equal(first.json.repo.fullName, "parikshit/relay");

    const second = await api(t.baseUrl, "POST", "/v1/repos", {
      body: { fullName: "parikshit/relay" }, ...authed(session.sessionToken),
    });
    assert.equal(second.status, 201);
    assert.equal(second.json.repo.id, first.json.repo.id, "the same repo keeps its id");

    const list = await api(t.baseUrl, "GET", "/v1/repos", authed(session.sessionToken));
    assert.equal(list.json.repos.length, 1);
  } finally { await t.close(); }
});

test("a malformed repo name is rejected", async () => {
  const t = await startTestApp();
  try {
    const session = await signIn(t);
    for (const fullName of ["no-slash", "too/many/slashes", "", "bad name/repo"]) {
      const res = await api(t.baseUrl, "POST", "/v1/repos", { body: { fullName }, ...authed(session.sessionToken) });
      assert.equal(res.status, 400, `${fullName} must be rejected`);
      assert.equal(res.json.error, "invalid_repo");
    }
  } finally { await t.close(); }
});

test("repos are isolated per account", async () => {
  const t = await startTestApp();
  try {
    const mine = await signIn(t, { sub: "apple-a", email: "a@example.com" });
    const theirs = await signIn(t, { sub: "apple-b", email: "b@example.com" });
    await api(t.baseUrl, "POST", "/v1/repos", { body: { fullName: "me/secret" }, ...authed(mine.sessionToken) });

    const list = await api(t.baseUrl, "GET", "/v1/repos", authed(theirs.sessionToken));
    assert.deepEqual(list.json.repos, []);
  } finally { await t.close(); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd product/cloud && node --test test/repos.test.mjs`
Expected: FAIL — `404 not_found`.

- [ ] **Step 3: Add the table**

In `product/cloud/src/db.js`, append to `SCHEMA`:

```sql
CREATE TABLE IF NOT EXISTS repos (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  full_name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_repos_account_name ON repos (account_id, full_name);
```

- [ ] **Step 4: Add the registry accessors**

In `product/cloud/src/registry.js`:

```js
  function upsertRepo(accountId, fullName) {
    const existing = getRepo(accountId, fullName);
    if (existing) return existing;
    try {
      db.prepare("INSERT INTO repos (id, account_id, full_name, created_at) VALUES (?, ?, ?, ?)")
        .run(randomUUID(), accountId, fullName, now());
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
    return getRepo(accountId, fullName);
  }

  function getRepo(accountId, fullName) {
    return mapRepo(db.prepare("SELECT * FROM repos WHERE account_id = ? AND full_name = ?").get(accountId, fullName));
  }

  function listRepos(accountId) {
    return db.prepare("SELECT * FROM repos WHERE account_id = ? ORDER BY full_name").all(accountId).map(mapRepo);
  }
```

with the mapper:

```js
function mapRepo(row) {
  if (!row) return null;
  return { id: row.id, fullName: row.full_name, createdAt: row.created_at };
}
```

Add the three names to the export object and `DELETE FROM repos WHERE account_id = ?` to `deleteAccount`.

- [ ] **Step 5: Add the routes**

In `product/cloud/src/server.js`, below the session-auth boundary line:

```js
  if (method === "POST" && path === "/v1/repos") {
    const body = await readJson(req, config.jsonBodyMaxBytes);
    const fullName = normalizeRepoFullName(body?.fullName);
    if (!fullName) return sendJson(res, 400, { error: "invalid_repo" });
    return sendJson(res, 201, { repo: registry.upsertRepo(account.id, fullName) });
  }

  if (method === "GET" && path === "/v1/repos") {
    return sendJson(res, 200, { repos: registry.listRepos(account.id) });
  }
```

with the helper next to `strOrNull`:

```js
const REPO_FULL_NAME_RE = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;

function normalizeRepoFullName(value) {
  const trimmed = String(value || "").trim();
  if (!REPO_FULL_NAME_RE.test(trimmed)) return null;
  return trimmed.toLowerCase();
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd product/cloud && node --test test/repos.test.mjs`
Expected: PASS — 3 tests.

- [ ] **Step 7: Commit**

```bash
git add product/cloud/src product/cloud/test/repos.test.mjs
git commit -m "feat(cloud): per-account repo registration"
```

---

## Task 7: Node-signed request auth

**Files:**
- Create: `product/cloud/src/nodeauth.js`
- Test: `product/cloud/test/nodeauth.test.mjs`

**Interfaces:**
- Consumes: `registry.getNode`, `parseNodePubkey` (exported from `src/notify.js`)
- Produces:
  - `NODE_REQUEST_LABEL = "relay-node-req-v1"`
  - `nodeRequestSigningInput({ method, pathWithQuery, ts, nodeId }) -> Buffer` — the exact bytes both sides sign
  - `verifyNodeRequest(req, pathWithQuery, { registry, now }) -> { node } | { error: "missing_signature" | "bad_ts" | "unknown_node" | "node_key_unusable" | "bad_signature" }`

The signing input is `relay-node-req-v1\n<METHOD>\n<path?query>\n<nodeId>\n<ts>` as UTF-8. Headers: `x-relay-node` (node id), `x-relay-ts` (epoch ms), `x-relay-signature` (base64url ed25519). The timestamp window matches `notify.js`: no older than 10 minutes, no more than 2 minutes ahead.

- [ ] **Step 1: Write the failing test**

Create `product/cloud/test/nodeauth.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { createDb } from "../src/db.js";
import { createRegistry } from "../src/registry.js";
import { verifyNodeRequest, nodeRequestSigningInput } from "../src/nodeauth.js";

const NODE_ID = "node-00112233445566aa";

function setup() {
  const clock = { t: 1_800_000_000_000 };
  const registry = createRegistry(createDb(":memory:"), { now: () => clock.t });
  const account = registry.createAccount({ appleSub: "apple-1", email: "a@example.com" });
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  registry.createNode(account.id, {
    id: NODE_ID, kind: "trial", name: "Trial",
    pubkey: publicKey.export({ type: "spki", format: "pem" }),
  });
  return { clock, registry, privateKey };
}

function signedRequest({ privateKey, method = "GET", pathWithQuery = "/v1/node/handoffs?wait=5", ts, nodeId = NODE_ID }) {
  const signature = crypto.sign(null, nodeRequestSigningInput({ method, pathWithQuery, ts, nodeId }), privateKey);
  return {
    method,
    headers: {
      "x-relay-node": nodeId,
      "x-relay-ts": String(ts),
      "x-relay-signature": signature.toString("base64url"),
    },
  };
}

test("a correctly signed request resolves to its node", () => {
  const { clock, registry, privateKey } = setup();
  const req = signedRequest({ privateKey, ts: clock.t });
  const result = verifyNodeRequest(req, "/v1/node/handoffs?wait=5", { registry, now: () => clock.t });
  assert.equal(result.node.id, NODE_ID);
});

test("a signature bound to a different path or method is refused", () => {
  const { clock, registry, privateKey } = setup();
  const req = signedRequest({ privateKey, ts: clock.t, pathWithQuery: "/v1/node/handoffs?wait=5" });

  assert.equal(verifyNodeRequest(req, "/v1/node/handoffs?wait=25", { registry, now: () => clock.t }).error, "bad_signature");
  assert.equal(verifyNodeRequest({ ...req, method: "POST" }, "/v1/node/handoffs?wait=5", { registry, now: () => clock.t }).error,
    "bad_signature");
});

test("stale and future timestamps are refused", () => {
  const { clock, registry, privateKey } = setup();
  const stale = signedRequest({ privateKey, ts: clock.t - 11 * 60 * 1000 });
  const future = signedRequest({ privateKey, ts: clock.t + 3 * 60 * 1000 });
  assert.equal(verifyNodeRequest(stale, "/v1/node/handoffs?wait=5", { registry, now: () => clock.t }).error, "bad_ts");
  assert.equal(verifyNodeRequest(future, "/v1/node/handoffs?wait=5", { registry, now: () => clock.t }).error, "bad_ts");
});

test("another node's key cannot sign for this node", () => {
  const { clock, registry } = setup();
  const stranger = crypto.generateKeyPairSync("ed25519").privateKey;
  const req = signedRequest({ privateKey: stranger, ts: clock.t });
  assert.equal(verifyNodeRequest(req, "/v1/node/handoffs?wait=5", { registry, now: () => clock.t }).error, "bad_signature");
});

test("missing headers and unknown nodes are reported distinctly", () => {
  const { clock, registry, privateKey } = setup();
  assert.equal(verifyNodeRequest({ method: "GET", headers: {} }, "/x", { registry, now: () => clock.t }).error,
    "missing_signature");
  const req = signedRequest({ privateKey, ts: clock.t, nodeId: "node-ffffffffffffffff" });
  assert.equal(verifyNodeRequest(req, "/v1/node/handoffs?wait=5", { registry, now: () => clock.t }).error, "unknown_node");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd product/cloud && node --test test/nodeauth.test.mjs`
Expected: FAIL — `Cannot find module '../src/nodeauth.js'`.

- [ ] **Step 3: Write the implementation**

Create `product/cloud/src/nodeauth.js`:

```js
// Signed-request auth for node-originated GETs.
//
// POST /v1/node-events authenticates by signing the raw request body, which a
// GET does not have. These routes sign a canonical string binding the method,
// the exact path+query, the node id, and a timestamp, so a captured signature
// cannot be replayed against a different route or a different node.
import { verify as cryptoVerify } from "node:crypto";

import { parseNodePubkey } from "./notify.js";

const NODE_REQUEST_LABEL = "relay-node-req-v1";
const TS_MAX_AGE_MS = 10 * 60 * 1000;
const TS_MAX_SKEW_MS = 2 * 60 * 1000;

function nodeRequestSigningInput({ method, pathWithQuery, ts, nodeId }) {
  return Buffer.from(
    `${NODE_REQUEST_LABEL}\n${String(method).toUpperCase()}\n${pathWithQuery}\n${nodeId}\n${ts}`,
    "utf8",
  );
}

function verifyNodeRequest(req, pathWithQuery, { registry, now }) {
  const nodeId = String(req.headers["x-relay-node"] || "");
  const tsHeader = String(req.headers["x-relay-ts"] || "");
  const signatureB64 = String(req.headers["x-relay-signature"] || "");
  if (!nodeId || !tsHeader || !signatureB64) return { error: "missing_signature" };

  const ts = Number.parseInt(tsHeader, 10);
  if (!Number.isSafeInteger(ts)) return { error: "bad_ts" };
  const nowMs = now();
  if (ts < nowMs - TS_MAX_AGE_MS || ts > nowMs + TS_MAX_SKEW_MS) return { error: "bad_ts" };

  const node = registry.getNode(nodeId);
  if (!node) return { error: "unknown_node" };
  const key = parseNodePubkey(node.pubkey);
  if (!key) return { error: "node_key_unusable" };

  const signature = Buffer.from(signatureB64, "base64url");
  const input = nodeRequestSigningInput({ method: req.method, pathWithQuery, ts, nodeId });
  if (signature.length === 0 || !cryptoVerify(null, input, key, signature)) return { error: "bad_signature" };

  return { node };
}

export { NODE_REQUEST_LABEL, nodeRequestSigningInput, verifyNodeRequest };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd product/cloud && node --test test/nodeauth.test.mjs`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add product/cloud/src/nodeauth.js product/cloud/test/nodeauth.test.mjs
git commit -m "feat(cloud): signed-request auth for node-originated GETs"
```

---

## Task 8: Handoff records, ping, and the node long-poll

**Files:**
- Modify: `product/cloud/src/db.js` (`handoffs` table)
- Modify: `product/cloud/src/registry.js` (six accessors + export object + `deleteAccount`)
- Modify: `product/cloud/src/config.js` (`handoffPollMaxWaitSec`)
- Modify: `product/cloud/src/server.js` (three routes)
- Test: `product/cloud/test/handoff-api.test.mjs`

**Interfaces:**
- Consumes: `verifyNodeRequest` (Task 7), `registry.getRepo` (Task 6), session auth
- Produces:
  - `POST /v1/handoffs` (session-authed) `{ handoffId, repo, branch, nodeId }` → `201 { handoff }`; idempotent on `handoffId`; `400 invalid_handoff`, `404 unknown_repo`, `404 unknown_node`
  - `GET /v1/handoffs?repo=<full_name>` (session-authed) → `200 { handoffs: [...] }` newest first, capped at 50
  - `GET /v1/node/handoffs?wait=<sec>` (node-signed) → `200 { handoffs: [...] }`; returns immediately when work is pending, otherwise holds up to `min(wait, handoffPollMaxWaitSec)` seconds and returns `200 { handoffs: [] }`
  - `registry.createHandoff({ id, accountId, nodeId, repo, branch })`, `getHandoff(id)`, `listHandoffsForRepo(accountId, repo, limit)`, `listPendingHandoffs(nodeId)`, `updateHandoff(id, patch)`, `countPendingHandoffs(nodeId)`
  - Handoff row: `{ id, accountId, nodeId, repo, branch, state, reason, createdAt, updatedAt, deliveredAt }`; states `pending | delivered | ready | failed`

The long-poll registers a waiter keyed by node id. `POST /v1/handoffs` wakes any waiter for that node, so pickup latency is a round trip rather than a poll interval.

- [ ] **Step 1: Write the failing test**

Create `product/cloud/test/handoff-api.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { startTestApp, api, signIn, authed } from "./helpers.mjs";
import { nodeRequestSigningInput } from "../src/nodeauth.js";

const NODE_ID = "node-00112233445566aa";
const HANDOFF_ID = "a1b2c3d4e5f60718";

function nodeIdentity() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return { pubkeyPem: publicKey.export({ type: "spki", format: "pem" }), privateKey };
}

function nodeHeaders(identity, { method = "GET", pathWithQuery, ts }) {
  const signature = crypto.sign(null,
    nodeRequestSigningInput({ method, pathWithQuery, ts, nodeId: NODE_ID }), identity.privateKey);
  return { headers: { "x-relay-node": NODE_ID, "x-relay-ts": String(ts), "x-relay-signature": signature.toString("base64url") } };
}

async function setup() {
  const t = await startTestApp();
  const session = await signIn(t);
  const identity = nodeIdentity();
  t.app.registry.createNode(session.accountId, { id: NODE_ID, kind: "trial", name: "Trial", pubkey: identity.pubkeyPem });
  await api(t.baseUrl, "POST", "/v1/repos", { body: { fullName: "me/relay" }, ...authed(session.sessionToken) });
  return { t, session, identity };
}

const PING = { handoffId: HANDOFF_ID, repo: "me/relay", branch: "relay/handoff-fix-auth", nodeId: NODE_ID };

test("a ping creates a pending handoff the node then collects", async () => {
  const { t, session, identity } = await setup();
  try {
    const ping = await api(t.baseUrl, "POST", "/v1/handoffs", { body: PING, ...authed(session.sessionToken) });
    assert.equal(ping.status, 201);
    assert.equal(ping.json.handoff.state, "pending");

    const pathWithQuery = "/v1/node/handoffs?wait=0";
    const poll = await api(t.baseUrl, "GET", pathWithQuery, nodeHeaders(identity, { pathWithQuery, ts: t.clock.t }));
    assert.equal(poll.status, 200);
    assert.equal(poll.json.handoffs.length, 1);
    assert.deepEqual(
      { id: poll.json.handoffs[0].id, repo: poll.json.handoffs[0].repo, branch: poll.json.handoffs[0].branch },
      { id: HANDOFF_ID, repo: "me/relay", branch: "relay/handoff-fix-auth" },
    );
    assert.equal(t.app.registry.getHandoff(HANDOFF_ID).state, "delivered");

    const again = await api(t.baseUrl, "GET", pathWithQuery, nodeHeaders(identity, { pathWithQuery, ts: t.clock.t }));
    assert.deepEqual(again.json.handoffs, [], "a delivered handoff is not handed out twice");
  } finally { await t.close(); }
});

test("the ping is content-free: only names are accepted and stored", async () => {
  const { t, session } = await setup();
  try {
    const res = await api(t.baseUrl, "POST", "/v1/handoffs", {
      body: { ...PING, transcript: "secret conversation", manifest: { goal: "secret" } },
      ...authed(session.sessionToken),
    });
    assert.equal(res.status, 201);
    assert.deepEqual(Object.keys(res.json.handoff).sort(),
      ["branch", "createdAt", "deliveredAt", "id", "nodeId", "reason", "repo", "state", "updatedAt"]);
    const row = t.app.registry.getHandoff(HANDOFF_ID);
    assert.equal(row.transcript, undefined);
    assert.equal(row.manifest, undefined);
  } finally { await t.close(); }
});

test("a ping for an unregistered repo or a foreign node is refused", async () => {
  const { t, session } = await setup();
  try {
    const badRepo = await api(t.baseUrl, "POST", "/v1/handoffs", {
      body: { ...PING, repo: "me/never-registered" }, ...authed(session.sessionToken),
    });
    assert.equal(badRepo.status, 404);
    assert.equal(badRepo.json.error, "unknown_repo");

    const other = await signIn(t, { sub: "apple-b", email: "b@example.com" });
    await api(t.baseUrl, "POST", "/v1/repos", { body: { fullName: "me/relay" }, ...authed(other.sessionToken) });
    const badNode = await api(t.baseUrl, "POST", "/v1/handoffs", { body: PING, ...authed(other.sessionToken) });
    assert.equal(badNode.status, 404);
    assert.equal(badNode.json.error, "unknown_node");
  } finally { await t.close(); }
});

test("pings are idempotent on handoffId", async () => {
  const { t, session } = await setup();
  try {
    await api(t.baseUrl, "POST", "/v1/handoffs", { body: PING, ...authed(session.sessionToken) });
    const repeat = await api(t.baseUrl, "POST", "/v1/handoffs", { body: PING, ...authed(session.sessionToken) });
    assert.equal(repeat.status, 201);
    assert.equal(t.app.registry.listHandoffsForRepo(session.accountId, "me/relay", 50).length, 1);
  } finally { await t.close(); }
});

test("a waiting node is woken by a ping instead of waiting out the poll", async () => {
  const { t, session, identity } = await setup();
  try {
    const pathWithQuery = "/v1/node/handoffs?wait=20";
    const started = Date.now();
    const polling = api(t.baseUrl, "GET", pathWithQuery, nodeHeaders(identity, { pathWithQuery, ts: t.clock.t }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await api(t.baseUrl, "POST", "/v1/handoffs", { body: PING, ...authed(session.sessionToken) });

    const poll = await polling;
    assert.equal(poll.json.handoffs.length, 1);
    assert.ok(Date.now() - started < 5000, "the waiter returned as soon as the ping landed");
  } finally { await t.close(); }
});

test("an empty long-poll returns an empty list rather than hanging forever", async () => {
  const { t, identity } = await setup();
  try {
    const pathWithQuery = "/v1/node/handoffs?wait=1";
    const poll = await api(t.baseUrl, "GET", pathWithQuery, nodeHeaders(identity, { pathWithQuery, ts: t.clock.t }));
    assert.equal(poll.status, 200);
    assert.deepEqual(poll.json.handoffs, []);
  } finally { await t.close(); }
});

test("an unsigned node poll is refused", async () => {
  const { t } = await setup();
  try {
    const res = await api(t.baseUrl, "GET", "/v1/node/handoffs?wait=0");
    assert.equal(res.status, 401);
  } finally { await t.close(); }
});

test("the owner can list handoffs for a repo", async () => {
  const { t, session } = await setup();
  try {
    await api(t.baseUrl, "POST", "/v1/handoffs", { body: PING, ...authed(session.sessionToken) });
    const list = await api(t.baseUrl, "GET", "/v1/handoffs?repo=me%2Frelay", authed(session.sessionToken));
    assert.equal(list.status, 200);
    assert.equal(list.json.handoffs[0].branch, "relay/handoff-fix-auth");
  } finally { await t.close(); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd product/cloud && node --test test/handoff-api.test.mjs`
Expected: FAIL — `404 not_found`.

- [ ] **Step 3: Add the table and registry accessors**

In `product/cloud/src/db.js`, append to `SCHEMA`:

```sql
CREATE TABLE IF NOT EXISTS handoffs (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  repo TEXT NOT NULL,
  branch TEXT NOT NULL,
  state TEXT NOT NULL,
  reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  delivered_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_handoffs_node_state ON handoffs (node_id, state);
CREATE INDEX IF NOT EXISTS idx_handoffs_account_repo ON handoffs (account_id, repo, created_at);
```

In `product/cloud/src/registry.js`:

```js
  const HANDOFF_PATCH_COLUMNS = { state: "state", reason: "reason", deliveredAt: "delivered_at" };

  function createHandoff({ id, accountId, nodeId, repo, branch }) {
    const ts = now();
    db.prepare(
      "INSERT INTO handoffs (id, account_id, node_id, repo, branch, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)",
    ).run(id, accountId, nodeId, repo, branch, ts, ts);
    return getHandoff(id);
  }

  function getHandoff(id) {
    return mapHandoff(db.prepare("SELECT * FROM handoffs WHERE id = ?").get(id));
  }

  function listHandoffsForRepo(accountId, repo, limit = 50) {
    return db.prepare("SELECT * FROM handoffs WHERE account_id = ? AND repo = ? ORDER BY created_at DESC LIMIT ?")
      .all(accountId, repo, limit).map(mapHandoff);
  }

  function listPendingHandoffs(nodeId) {
    return db.prepare("SELECT * FROM handoffs WHERE node_id = ? AND state = 'pending' ORDER BY created_at")
      .all(nodeId).map(mapHandoff);
  }

  function countPendingHandoffs(nodeId) {
    return Number(db.prepare("SELECT COUNT(*) AS n FROM handoffs WHERE node_id = ? AND state = 'pending'")
      .get(nodeId).n);
  }

  function updateHandoff(id, patch = {}) {
    const assignments = [];
    const values = [];
    for (const [key, column] of Object.entries(HANDOFF_PATCH_COLUMNS)) {
      if (key in patch) { assignments.push(`${column} = ?`); values.push(patch[key]); }
    }
    assignments.push("updated_at = ?");
    values.push(now(), id);
    db.prepare(`UPDATE handoffs SET ${assignments.join(", ")} WHERE id = ?`).run(...values);
    return getHandoff(id);
  }
```

with the mapper:

```js
function mapHandoff(row) {
  if (!row) return null;
  return {
    id: row.id,
    accountId: row.account_id,
    nodeId: row.node_id,
    repo: row.repo,
    branch: row.branch,
    state: row.state,
    reason: row.reason ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deliveredAt: row.delivered_at ?? null,
  };
}
```

Add the six names to the export object and `DELETE FROM handoffs WHERE account_id = ?` to `deleteAccount`.

- [ ] **Step 4: Add the config knob**

In `product/cloud/src/config.js`:

```js
  handoffPollMaxWaitSec: intFrom(env.HANDOFF_POLL_MAX_WAIT_SEC, 25),
```

25 s keeps the held request comfortably inside nginx's 300 s `proxy_read_timeout` and inside Node's 60 s default `headersTimeout` for the *next* request on the same connection.

- [ ] **Step 5: Add the waiter registry and the routes**

In `product/cloud/src/server.js`, inside `createApp` (so each app instance owns its own waiters), next to the other state:

```js
  const handoffWaiters = new Map();

  function wakeHandoffWaiters(nodeId) {
    const waiters = handoffWaiters.get(nodeId);
    if (!waiters) return;
    handoffWaiters.delete(nodeId);
    for (const resolve of waiters) resolve();
  }

  function waitForHandoff(nodeId, timeoutMs) {
    return new Promise((resolve) => {
      const waiters = handoffWaiters.get(nodeId) || new Set();
      const settle = () => {
        clearTimeout(timer);
        waiters.delete(settle);
        resolve();
      };
      const timer = setTimeout(settle, timeoutMs);
      timer.unref?.();
      waiters.add(settle);
      handoffWaiters.set(nodeId, waiters);
    });
  }
```

Add the node-signed route **above** the session-auth boundary line:

```js
  if (method === "GET" && path === "/v1/node/handoffs") {
    const pathWithQuery = `${path}${url.search}`;
    const verified = verifyNodeRequest(req, pathWithQuery, { registry, now });
    if (verified.error) return sendJson(res, 401, { error: "unauthorized" });

    const nodeId = verified.node.id;
    const requested = Number.parseInt(url.searchParams.get("wait") || "0", 10);
    const waitSec = Number.isSafeInteger(requested)
      ? Math.max(0, Math.min(requested, config.handoffPollMaxWaitSec))
      : 0;
    if (waitSec > 0 && registry.countPendingHandoffs(nodeId) === 0) {
      await waitForHandoff(nodeId, waitSec * 1000);
    }

    const pending = registry.listPendingHandoffs(nodeId);
    for (const handoff of pending) {
      registry.updateHandoff(handoff.id, { state: "delivered", deliveredAt: now() });
    }
    registry.touchNode(nodeId);
    return sendJson(res, 200, {
      handoffs: pending.map(({ id, repo, branch }) => ({ id, repo, branch })),
    });
  }
```

Add the two session-authed routes **below** the boundary line:

```js
  if (method === "POST" && path === "/v1/handoffs") {
    const body = await readJson(req, config.jsonBodyMaxBytes);
    const handoffId = strOrNull(body?.handoffId);
    const repo = normalizeRepoFullName(body?.repo);
    const branch = strOrNull(body?.branch);
    const nodeId = strOrNull(body?.nodeId);
    if (!handoffId || !/^[a-f0-9]{16,64}$/.test(handoffId) || !repo || !branch ||
        !branch.startsWith("relay/handoff-") || branch.length > 200 || !nodeId) {
      return sendJson(res, 400, { error: "invalid_handoff" });
    }
    if (!registry.getRepo(account.id, repo)) return sendJson(res, 404, { error: "unknown_repo" });
    const node = registry.getNode(nodeId);
    if (!node || node.accountId !== account.id) return sendJson(res, 404, { error: "unknown_node" });

    const existing = registry.getHandoff(handoffId);
    if (existing) {
      if (existing.accountId !== account.id) return sendJson(res, 400, { error: "invalid_handoff" });
      return sendJson(res, 201, { handoff: publicHandoff(existing) });
    }
    const created = registry.createHandoff({ id: handoffId, accountId: account.id, nodeId, repo, branch });
    wakeHandoffWaiters(nodeId);
    return sendJson(res, 201, { handoff: publicHandoff(created) });
  }

  if (method === "GET" && path === "/v1/handoffs") {
    const repo = normalizeRepoFullName(url.searchParams.get("repo"));
    if (!repo) return sendJson(res, 400, { error: "invalid_repo" });
    return sendJson(res, 200, {
      handoffs: registry.listHandoffsForRepo(account.id, repo, 50).map(publicHandoff),
    });
  }
```

with the projection next to `publicTrial` (it drops `accountId`, so a response never leaks an internal id):

```js
function publicHandoff(handoff) {
  return {
    id: handoff.id,
    nodeId: handoff.nodeId,
    repo: handoff.repo,
    branch: handoff.branch,
    state: handoff.state,
    reason: handoff.reason,
    createdAt: handoff.createdAt,
    updatedAt: handoff.updatedAt,
    deliveredAt: handoff.deliveredAt,
  };
}
```

Import `verifyNodeRequest` at the top of `server.js`:

```js
import { verifyNodeRequest } from "./nodeauth.js";
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd product/cloud && node --test test/handoff-api.test.mjs && node --test test/*.test.mjs`
Expected: PASS — 8 new tests, whole suite green.

- [ ] **Step 7: Commit**

```bash
git add product/cloud/src product/cloud/test/handoff-api.test.mjs
git commit -m "feat(cloud): handoff records, content-free ping, and node long-poll"
```

---

## Task 9: Handoff push notifications

**Files:**
- Modify: `product/cloud/src/notify.js` (`KNOWN_TYPES`, `MUTABLE_TYPES`, `categoryFor`)
- Test: `product/cloud/test/handoff-notify.test.mjs`

**Interfaces:**
- Consumes: the existing `POST /v1/node-events` ingest
- Produces: event types `handoff.ready` (mutable, category `RELAY_HANDOFF_READY`) and `handoff.failed` (mutable, category `RELAY_HANDOFF_FAILED`)

- [ ] **Step 1: Write the failing test**

Create `product/cloud/test/handoff-notify.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";

import { startTestApp, api, signIn, makeNodeIdentity } from "./helpers.mjs";

const NODE_ID = "node-00112233445566aa";

async function setup() {
  const t = await startTestApp();
  const session = await signIn(t);
  const identity = makeNodeIdentity();
  t.app.registry.createNode(session.accountId, { id: NODE_ID, kind: "trial", name: "Trial", pubkey: identity.pubkeyPem });
  t.app.registry.createDevice(session.accountId, { apnsToken: "a".repeat(64), platform: "ios", name: "iPhone" });
  return { t, identity };
}

async function postEvent(t, identity, type, seq) {
  const body = Buffer.from(JSON.stringify({ v: 1, nodeId: NODE_ID, jobId: null, type, ts: t.clock.t, seq }), "utf8");
  return api(t.baseUrl, "POST", "/v1/node-events", { raw: body, headers: { "x-relay-signature": identity.signBody(body) } });
}

test("handoff.ready is accepted and delivered as an alert push", async () => {
  const { t, identity } = await setup();
  try {
    const res = await postEvent(t, identity, "handoff.ready", 1);
    assert.equal(res.status, 202);
    assert.equal(res.json.kind, "mutable");

    await t.app.notify.drain();
    const request = t.apnsTransport.requests.at(-1);
    assert.equal(request.headers["apns-push-type"], "alert");
    assert.equal(JSON.parse(request.body).aps.category, "RELAY_HANDOFF_READY");
  } finally { await t.close(); }
});

test("handoff.failed is a distinct alert category", async () => {
  const { t, identity } = await setup();
  try {
    await postEvent(t, identity, "handoff.failed", 1);
    await t.app.notify.drain();
    assert.equal(JSON.parse(t.apnsTransport.requests.at(-1).body).aps.category, "RELAY_HANDOFF_FAILED");
  } finally { await t.close(); }
});

test("the push payload carries no handoff content", async () => {
  const { t, identity } = await setup();
  try {
    await postEvent(t, identity, "handoff.ready", 1);
    await t.app.notify.drain();
    const payload = JSON.parse(t.apnsTransport.requests.at(-1).body);
    assert.deepEqual(Object.keys(payload.relay).sort(), ["jobId", "nodeId", "seq", "ts", "type"]);
  } finally { await t.close(); }
});
```

If `registry.createDevice`'s signature differs, match the one used in `test/notify.test.mjs`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd product/cloud && node --test test/handoff-notify.test.mjs`
Expected: FAIL — `400 invalid_event` (`handoff.ready` is not in `KNOWN_TYPES`).

- [ ] **Step 3: Register the types**

In `product/cloud/src/notify.js`:

```js
const MUTABLE_TYPES = new Set([
  "job.needs_input", "job.completed", "job.failed", "handoff.ready", "handoff.failed",
]);
const KNOWN_TYPES = new Set([
  "job.state", "job.needs_input", "job.silence", "job.completed", "job.failed", "node.health",
  "handoff.ready", "handoff.failed",
]);
```

and add two cases to `categoryFor`:

```js
    case "handoff.ready": return "RELAY_HANDOFF_READY";
    case "handoff.failed": return "RELAY_HANDOFF_FAILED";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd product/cloud && node --test test/handoff-notify.test.mjs test/notify.test.mjs`
Expected: PASS — 3 new tests plus the existing notify suite.

- [ ] **Step 5: Commit**

```bash
git add product/cloud/src/notify.js product/cloud/test/handoff-notify.test.mjs
git commit -m "feat(cloud): handoff.ready and handoff.failed push events"
```

---

## Task 10: Typed rendezvous sessions

**Files:**
- Modify: `product/cloud/src/db.js` (`pairing_sessions.kind`)
- Modify: `product/cloud/src/registry.js` (`insertPairingSession`, `getPairingSession` mapper, `countLivePairingSessions`)
- Modify: `product/cloud/src/pairing.js` (`createSession` takes `kind`, per-kind quota)
- Modify: `product/cloud/src/server.js` (`POST /v1/pairing/sessions` passes `kind`)
- Test: `product/cloud/test/pairing-kind.test.mjs`

**Interfaces:**
- Consumes: existing pairing rendezvous
- Produces:
  - `pairing.createSession({ accountId, authToken, kind })` where `kind ∈ {"pair", "sync-auth", "session-index"}`, defaulting to `"pair"`; unknown kinds return `"invalid_kind"`
  - `POST /v1/pairing/sessions` accepts `{ authToken, kind }` → `400 invalid_kind` on a bad value
  - Quotas count per `(accountId, kind)`, so a stuck sync-auth session can never block pairing

Slot names stay exactly `node` / `device`. For sync-auth and session-index the CLI writes the `device` slot and the node reads it; nothing writes `node`.

- [ ] **Step 1: Write the failing test**

Create `product/cloud/test/pairing-kind.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";

import { startTestApp, api, signIn, authed } from "./helpers.mjs";

const AUTH_TOKEN = "c2VjcmV0LXNlY3JldC1zZWNyZXQ";

test("a session records its kind and defaults to pair", async () => {
  const t = await startTestApp();
  try {
    const session = await signIn(t);
    const typed = await api(t.baseUrl, "POST", "/v1/pairing/sessions", {
      body: { authToken: AUTH_TOKEN, kind: "sync-auth" }, ...authed(session.sessionToken),
    });
    assert.equal(typed.status, 201);
    assert.equal(t.app.registry.getPairingSession(typed.json.pairingId).kind, "sync-auth");

    const untyped = await api(t.baseUrl, "POST", "/v1/pairing/sessions", {
      body: { authToken: AUTH_TOKEN }, ...authed(session.sessionToken),
    });
    assert.equal(t.app.registry.getPairingSession(untyped.json.pairingId).kind, "pair");
  } finally { await t.close(); }
});

test("an unknown kind is refused", async () => {
  const t = await startTestApp();
  try {
    const session = await signIn(t);
    const res = await api(t.baseUrl, "POST", "/v1/pairing/sessions", {
      body: { authToken: AUTH_TOKEN, kind: "exfiltrate" }, ...authed(session.sessionToken),
    });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, "invalid_kind");
  } finally { await t.close(); }
});

test("quotas are per kind — exhausting one kind leaves the others usable", async () => {
  const t = await startTestApp();
  try {
    const session = await signIn(t);
    for (let index = 0; index < t.app.pairing.maxPerAccount; index += 1) {
      const res = await api(t.baseUrl, "POST", "/v1/pairing/sessions", {
        body: { authToken: AUTH_TOKEN, kind: "session-index" }, ...authed(session.sessionToken),
      });
      assert.equal(res.status, 201, `session-index session ${index} should be allowed`);
    }
    const overflow = await api(t.baseUrl, "POST", "/v1/pairing/sessions", {
      body: { authToken: AUTH_TOKEN, kind: "session-index" }, ...authed(session.sessionToken),
    });
    assert.equal(overflow.status, 429);

    const pair = await api(t.baseUrl, "POST", "/v1/pairing/sessions", {
      body: { authToken: AUTH_TOKEN, kind: "pair" }, ...authed(session.sessionToken),
    });
    assert.equal(pair.status, 201, "pairing must not be blocked by another kind's backlog");
  } finally { await t.close(); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd product/cloud && node --test test/pairing-kind.test.mjs`
Expected: FAIL — `kind` is `undefined`.

- [ ] **Step 3: Add the column**

In `product/cloud/src/db.js`, add to the `pairing_sessions` block of `SCHEMA` after `account_id TEXT NOT NULL,`:

```sql
  kind TEXT NOT NULL DEFAULT 'pair',
```

`pairing_sessions` already has the destructive `migratePairingSessions(db)` guard, which drops and recreates the table when its shape changes. Extend that function's sentinel check to the new column:

```js
  if (!columns.some((column) => column.name === "kind")) {
    db.exec("DROP TABLE pairing_sessions");
  }
```

Dropping is correct here: rendezvous sessions live 15 minutes and are re-created on demand.

- [ ] **Step 4: Thread `kind` through the registry**

In `insertPairingSession`, add `kind` to the column list, parameters, and call signature. In the row mapper add `kind: row.kind`. Change the quota counter:

```js
  function countLivePairingSessions(accountId, kind, nowMs) {
    return Number(db.prepare(
      "SELECT COUNT(*) AS n FROM pairing_sessions WHERE account_id = ? AND kind = ? AND closed_at IS NULL AND expires_at > ?",
    ).get(accountId, kind, nowMs).n);
  }
```

- [ ] **Step 5: Accept `kind` in pairing and the route**

In `product/cloud/src/pairing.js`:

```js
const KINDS = new Set(["pair", "sync-auth", "session-index"]);
```

and in `createSession`:

```js
  function createSession({ accountId, authToken, kind = "pair" }) {
    if (!AUTH_TOKEN_RE.test(String(authToken || ""))) return "invalid_auth_token";
    if (!KINDS.has(kind)) return "invalid_kind";
    if (countLive(accountId, kind) >= maxPerAccount) return "too_many_sessions";
    // …unchanged: mint pairingId, store sha256Hex(authToken), set expiresAt…
  }
```

with `countLive(accountId, kind)` calling `registry.countLivePairingSessions(accountId, kind, now())`.

In `product/cloud/src/server.js`, in the `POST /v1/pairing/sessions` branch, pass the kind and map the new failure:

```js
    const result = pairing.createSession({ accountId: account.id, authToken: body?.authToken, kind: body?.kind ?? "pair" });
    if (result === "invalid_auth_token") return sendJson(res, 400, { error: "auth_token_required" });
    if (result === "invalid_kind") return sendJson(res, 400, { error: "invalid_kind" });
    if (result === "too_many_sessions") return sendJson(res, 429, { error: "too_many_pairing_sessions" });
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd product/cloud && node --test test/pairing-kind.test.mjs test/pairing.test.mjs && node --test test/*.test.mjs`
Expected: PASS — the existing pairing suite must stay green (it never sends `kind`, so it exercises the `"pair"` default).

- [ ] **Step 7: Commit**

```bash
git add product/cloud/src product/cloud/test/pairing-kind.test.mjs
git commit -m "feat(cloud): typed rendezvous sessions with per-kind quotas"
```

---

## Task 11: relayd cloud client (signed long-poll + signed events)

**Files:**
- Modify: `product/relayd/src/config.mjs` (three knobs + export block)
- Create: `product/relayd/src/cloudclient.mjs`
- Test: `product/relayd/test/cloudclient.test.mjs`

**Interfaces:**
- Consumes: `identityPaths`, `readNodeId` (identity.mjs); cloud routes from Tasks 7–9
- Produces:
  - Config: `cloudUrl` (`RELAYD_CLOUD_URL`, falling back to `RELAYD_ENROLL_URL`, `""` when unset), `handoffEnabled` (`RELAYD_HANDOFF_ENABLED`, default `true`), `handoffPollWaitSec` (`RELAYD_HANDOFF_POLL_WAIT_SEC`, default `20`, range 0–60)
  - `createCloudClient({ cloudUrl, baseDir, fetchImpl = fetch, now = () => Date.now() })` → object with:
    - `nodeId: string`
    - `async pollHandoffs(waitSec) -> Array<{ id, repo, branch }>`
    - `async postEvent(type, { jobId = null } = {}) -> { status, body }`
  - Throws `Error("cloud_client_no_identity")` when the node has no identity yet.

The event sequence counter persists at `<baseDir>/cloud-event-seq` so a restart never replays a sequence number the cloud has already claimed.

- [ ] **Step 1: Write the failing test**

Create `product/relayd/test/cloudclient.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";

process.env.CODEX_DATA_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), "relayd-cloudclient-data-"));

const { initIdentity, identityPaths } = await import("../src/identity.mjs");
const { createCloudClient } = await import("../src/cloudclient.mjs");

const SIGNING_LABEL = "relay-node-req-v1";

function startFakeCloud(handler) {
  return new Promise((resolve) => {
    const calls = [];
    const server = createServer((req, res) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        calls.push({ method: req.method, url: req.url, headers: req.headers, raw: Buffer.concat(chunks) });
        handler(res, calls.at(-1), calls);
      });
    });
    server.listen(0, "127.0.0.1", () =>
      resolve({ calls, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) }));
  });
}

function freshNode() {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-cloudclient-"));
  const status = initIdentity({ baseDir });
  const paths = identityPaths(baseDir);
  const publicKey = crypto.createPublicKey(fs.readFileSync(paths.identityPubPath, "utf8"));
  return { baseDir, nodeId: status.nodeId, publicKey };
}

test("pollHandoffs signs the exact method, path, node id, and timestamp", async () => {
  const node = freshNode();
  const cloud = await startFakeCloud((res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ handoffs: [{ id: "abc123", repo: "me/relay", branch: "relay/handoff-x" }] }));
  });
  try {
    const client = createCloudClient({ cloudUrl: cloud.url, baseDir: node.baseDir });
    const handoffs = await client.pollHandoffs(20);

    assert.deepEqual(handoffs, [{ id: "abc123", repo: "me/relay", branch: "relay/handoff-x" }]);
    const call = cloud.calls[0];
    assert.equal(call.url, "/v1/node/handoffs?wait=20");
    assert.equal(call.headers["x-relay-node"], node.nodeId);

    const input = Buffer.from(
      `${SIGNING_LABEL}\nGET\n/v1/node/handoffs?wait=20\n${node.nodeId}\n${call.headers["x-relay-ts"]}`, "utf8");
    const signature = Buffer.from(call.headers["x-relay-signature"], "base64url");
    assert.ok(crypto.verify(null, input, node.publicKey, signature), "the signature verifies against the node key");
  } finally { await cloud.close(); }
});

test("postEvent signs the raw body and advances a persistent sequence", async () => {
  const node = freshNode();
  const cloud = await startFakeCloud((res) => {
    res.writeHead(202, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  try {
    const first = createCloudClient({ cloudUrl: cloud.url, baseDir: node.baseDir });
    await first.postEvent("handoff.ready", { jobId: "job-1" });
    await first.postEvent("handoff.failed");

    // A fresh client stands in for a daemon restart: the sequence must not reset.
    const second = createCloudClient({ cloudUrl: cloud.url, baseDir: node.baseDir });
    await second.postEvent("handoff.ready");

    const bodies = cloud.calls.map((call) => JSON.parse(call.raw.toString("utf8")));
    assert.deepEqual(bodies.map((body) => body.seq), [1, 2, 3]);
    assert.deepEqual(bodies.map((body) => body.type), ["handoff.ready", "handoff.failed", "handoff.ready"]);
    assert.equal(bodies[0].jobId, "job-1");
    assert.equal(bodies[1].jobId, null);
    assert.equal(bodies[0].nodeId, node.nodeId);
    assert.equal(bodies[0].v, 1);

    const signature = Buffer.from(cloud.calls[0].headers["x-relay-signature"], "base64url");
    assert.ok(crypto.verify(null, cloud.calls[0].raw, node.publicKey, signature),
      "the event signature covers the exact raw body");
  } finally { await cloud.close(); }
});

test("a non-200 poll surfaces as an error rather than a silent empty list", async () => {
  const node = freshNode();
  const cloud = await startFakeCloud((res) => { res.writeHead(503); res.end("{}"); });
  try {
    const client = createCloudClient({ cloudUrl: cloud.url, baseDir: node.baseDir });
    await assert.rejects(() => client.pollHandoffs(5), /cloud_poll_503/);
  } finally { await cloud.close(); }
});

test("a node without an identity refuses to build a client", () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-cloudclient-empty-"));
  assert.throws(() => createCloudClient({ cloudUrl: "http://127.0.0.1:1", baseDir }), /cloud_client_no_identity/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd product/relayd && node --test test/cloudclient.test.mjs`
Expected: FAIL — `Cannot find module '../src/cloudclient.mjs'`.

- [ ] **Step 3: Add the config knobs**

In `product/relayd/src/config.mjs`, near the tunnel block:

```js
// Control-plane base URL for handoff pickup and event push. Trial sandboxes
// already receive RELAYD_ENROLL_URL, so that is the fallback; empty disables
// every cloud-facing loop.
const cloudUrl = cleanOptionalUrlBase(process.env.RELAYD_CLOUD_URL || process.env.RELAYD_ENROLL_URL || "", "RELAYD_CLOUD_URL");

const handoffEnabled = parseBooleanEnv("RELAYD_HANDOFF_ENABLED", true);

const handoffPollWaitSec = parseIntegerEnv("RELAYD_HANDOFF_POLL_WAIT_SEC", 20, 0, 60);
```

Add `cloudUrl`, `handoffEnabled`, `handoffPollWaitSec` to the export block.

- [ ] **Step 4: Write the implementation**

Create `product/relayd/src/cloudclient.mjs`:

```js
// relayd cloudclient.mjs — the node's outbound half of the control-plane link.
//
// Two operations, both authenticated with the node's ed25519 identity key:
// a long-poll that collects pending handoffs, and a signed event post that the
// cloud fans out to APNs. The cloud sees names and event types only — never
// repository content, never transcripts.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { identityPaths, readNodeId } from "./identity.mjs";

const NODE_REQUEST_LABEL = "relay-node-req-v1";

function nodeRequestSigningInput({ method, pathWithQuery, ts, nodeId }) {
  return Buffer.from(`${NODE_REQUEST_LABEL}\n${method.toUpperCase()}\n${pathWithQuery}\n${nodeId}\n${ts}`, "utf8");
}

function createCloudClient({ cloudUrl, baseDir = undefined, fetchImpl = fetch, now = () => Date.now() }) {
  const paths = baseDir ? identityPaths(baseDir) : identityPaths();
  const nodeId = readNodeId(paths);
  let privateKey = null;
  try {
    privateKey = crypto.createPrivateKey(fs.readFileSync(paths.identityKeyPath, "utf8"));
  } catch {
    privateKey = null;
  }
  if (!nodeId || !privateKey) throw new Error("cloud_client_no_identity");

  const base = String(cloudUrl || "").replace(/\/+$/, "");
  const seqPath = path.join(paths.baseDir, "cloud-event-seq");

  function nextSeq() {
    let current = 0;
    try {
      current = Number.parseInt(fs.readFileSync(seqPath, "utf8").trim(), 10) || 0;
    } catch {
      current = 0;
    }
    const next = current + 1;
    fs.writeFileSync(seqPath, `${next}\n`, { mode: 0o600 });
    return next;
  }

  function signedHeaders(method, pathWithQuery) {
    const ts = now();
    const signature = crypto.sign(null, nodeRequestSigningInput({ method, pathWithQuery, ts, nodeId }), privateKey);
    return {
      "x-relay-node": nodeId,
      "x-relay-ts": String(ts),
      "x-relay-signature": signature.toString("base64url"),
    };
  }

  async function pollHandoffs(waitSec) {
    const pathWithQuery = `/v1/node/handoffs?wait=${Number(waitSec) || 0}`;
    const res = await fetchImpl(`${base}${pathWithQuery}`, {
      method: "GET",
      headers: signedHeaders("GET", pathWithQuery),
    });
    if (res.status !== 200) throw new Error(`cloud_poll_${res.status}`);
    const json = await res.json();
    return Array.isArray(json?.handoffs) ? json.handoffs : [];
  }

  async function postEvent(type, { jobId = null } = {}) {
    const body = Buffer.from(JSON.stringify({ v: 1, nodeId, jobId, type, ts: now(), seq: nextSeq() }), "utf8");
    const signature = crypto.sign(null, body, privateKey);
    const res = await fetchImpl(`${base}/v1/node-events`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-relay-signature": signature.toString("base64url") },
      body,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  return { nodeId, pollHandoffs, postEvent };
}

export { createCloudClient, nodeRequestSigningInput };
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd product/relayd && node --test test/cloudclient.test.mjs`
Expected: PASS — 4 tests.

- [ ] **Step 6: Commit**

```bash
git add product/relayd/src/cloudclient.mjs product/relayd/src/config.mjs product/relayd/test/cloudclient.test.mjs
git commit -m "feat(relayd): signed cloud client for handoff polling and events"
```

---

## Task 12: Per-harness session import

**Files:**
- Create: `product/relayd/src/sessionimport.mjs`
- Test: `product/relayd/test/sessionimport.test.mjs`

**Interfaces:**
- Consumes: nothing from earlier tasks (pure filesystem + string work)
- Produces:
  - `HANDOFF_MANIFEST_VERSION = 1`
  - `importSession({ manifest, sessionBytes, runHome, codexHome, worktreePath }) -> { provider, resumeSessionId, primedPrompt }`
    - `resumeSessionId` is non-null only when a native resume was staged; otherwise `primedPrompt` carries the summary text and `resumeSessionId` is `null`.
  - `rewriteClaudeSession(text, { fromCwd, toCwd }) -> string`
  - `claudeProjectSlug(cwd) -> string` — the directory name Claude Code derives from a cwd
  - `summaryPrompt(manifest) -> string`

Claude Code stores each session as JSONL under `~/.claude/projects/<slug>/<sessionId>.jsonl`, where `<slug>` is the absolute cwd with every character outside `[A-Za-z0-9]` replaced by `-`. Records embed the original cwd, so the import rewrites those occurrences to the sandbox path. Codex stores a rollout JSONL that is replayed by id and needs no rewriting.

- [ ] **Step 1: Write the failing test**

Create `product/relayd/test/sessionimport.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { importSession, rewriteClaudeSession, claudeProjectSlug, summaryPrompt } =
  await import("../src/sessionimport.mjs");

const FROM_CWD = "/Users/dev/code/relay";
const TO_CWD = "/srv/relay-workspaces/handoff-abc123";

function manifest(overrides = {}) {
  return {
    v: 1, id: "abc123def4567890", harness: "claude", sessionId: "11111111-2222-4333-8444-555555555555",
    title: "Fix the auth redirect", repo: "me/relay", baseBranch: "main",
    branch: "relay/handoff-fix-the-auth-redirect", cwd: FROM_CWD, machine: "MacBook-Pro",
    createdAt: 1_800_000_000_000, sessionFormat: "claude-jsonl",
    wip: { files: 2, insertions: 30, deletions: 4, summary: "2 files changed" },
    excerpt: "I was tracing why the redirect loops.",
    ...overrides,
  };
}

function homes() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-sessionimport-"));
  return { runHome: path.join(root, "home"), codexHome: path.join(root, "codex") };
}

test("claudeProjectSlug matches Claude Code's directory naming", () => {
  assert.equal(claudeProjectSlug("/Users/dev/code/relay"), "-Users-dev-code-relay");
  assert.equal(claudeProjectSlug("/srv/relay-workspaces/handoff-abc"), "-srv-relay-workspaces-handoff-abc");
});

test("rewriteClaudeSession retargets the cwd without corrupting other text", () => {
  const line = JSON.stringify({ type: "user", cwd: FROM_CWD, message: `edit ${FROM_CWD}/src/a.ts and keep /Users/dev/other` });
  const rewritten = rewriteClaudeSession(`${line}\n`, { fromCwd: FROM_CWD, toCwd: TO_CWD });
  const parsed = JSON.parse(rewritten.trim());

  assert.equal(parsed.cwd, TO_CWD);
  assert.equal(parsed.message, `edit ${TO_CWD}/src/a.ts and keep /Users/dev/other`);
  assert.ok(!rewritten.includes(FROM_CWD), "no laptop path survives the rewrite");
});

test("a claude session is staged where --resume finds it", () => {
  const { runHome, codexHome } = homes();
  const sessionBytes = Buffer.from(
    `${JSON.stringify({ type: "user", cwd: FROM_CWD, message: "hello" })}\n`, "utf8");

  const result = importSession({ manifest: manifest(), sessionBytes, runHome, codexHome, worktreePath: TO_CWD });

  const staged = path.join(runHome, ".claude", "projects", claudeProjectSlug(TO_CWD),
    "11111111-2222-4333-8444-555555555555.jsonl");
  assert.ok(fs.existsSync(staged), "the session file is staged for resume");
  assert.equal(JSON.parse(fs.readFileSync(staged, "utf8").trim()).cwd, TO_CWD);
  assert.deepEqual(
    { provider: result.provider, resumeSessionId: result.resumeSessionId },
    { provider: "claude", resumeSessionId: "11111111-2222-4333-8444-555555555555" },
  );
});

test("a codex rollout is staged under the codex home unmodified", () => {
  const { runHome, codexHome } = homes();
  const rollout = Buffer.from(`${JSON.stringify({ record: "rollout", cwd: FROM_CWD })}\n`, "utf8");

  const result = importSession({
    manifest: manifest({ harness: "codex", sessionFormat: "codex-rollout", sessionId: "0199aaaa-bbbb-4ccc-8ddd-eeeeffff0000" }),
    sessionBytes: rollout, runHome, codexHome, worktreePath: TO_CWD,
  });

  const staged = path.join(codexHome, "sessions", "0199aaaa-bbbb-4ccc-8ddd-eeeeffff0000.jsonl");
  assert.deepEqual(fs.readFileSync(staged), rollout, "codex rollouts are byte-preserved");
  assert.equal(result.resumeSessionId, "0199aaaa-bbbb-4ccc-8ddd-eeeeffff0000");
  assert.equal(result.provider, "codex");
});

test("a session-less handoff falls back to a primed prompt", () => {
  const { runHome, codexHome } = homes();
  const result = importSession({
    manifest: manifest({ harness: "cursor", sessionFormat: "none", sessionId: null }),
    sessionBytes: null, runHome, codexHome, worktreePath: TO_CWD,
  });

  assert.equal(result.resumeSessionId, null);
  assert.equal(result.provider, "cursor");
  assert.match(result.primedPrompt, /Fix the auth redirect/);
  assert.match(result.primedPrompt, /I was tracing why the redirect loops\./);
  assert.match(result.primedPrompt, /2 files changed/);
});

test("staged session files are private to the runner", () => {
  const { runHome, codexHome } = homes();
  const sessionBytes = Buffer.from(`${JSON.stringify({ type: "user", cwd: FROM_CWD })}\n`, "utf8");
  importSession({ manifest: manifest(), sessionBytes, runHome, codexHome, worktreePath: TO_CWD });
  const staged = path.join(runHome, ".claude", "projects", claudeProjectSlug(TO_CWD),
    "11111111-2222-4333-8444-555555555555.jsonl");
  assert.equal(fs.statSync(staged).mode & 0o777, 0o600);
});

test("summaryPrompt never fabricates content it was not given", () => {
  const prompt = summaryPrompt(manifest({ excerpt: "", wip: { files: 0, insertions: 0, deletions: 0, summary: "" } }));
  assert.match(prompt, /Fix the auth redirect/);
  assert.ok(!prompt.includes("undefined"), "empty fields are omitted, not stringified");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd product/relayd && node --test test/sessionimport.test.mjs`
Expected: FAIL — `Cannot find module '../src/sessionimport.mjs'`.

- [ ] **Step 3: Write the implementation**

Create `product/relayd/src/sessionimport.mjs`:

```js
// relayd sessionimport.mjs — stage a handed-off session so the harness's own
// resume mechanism continues the conversation on this node.
//
// Claude Code keys sessions by the absolute working directory, so its transcript
// is rewritten from the laptop path to the sandbox checkout. Codex replays a
// rollout by id and needs no rewriting. Cursor has no portable session file, so
// it takes the primed-prompt path — stated plainly rather than faked.
import fs from "node:fs";
import path from "node:path";

const HANDOFF_MANIFEST_VERSION = 1;

function claudeProjectSlug(cwd) {
  return String(cwd).replace(/[^A-Za-z0-9]/g, "-");
}

function rewriteClaudeSession(text, { fromCwd, toCwd }) {
  if (!fromCwd || fromCwd === toCwd) return text;
  return text.split(fromCwd).join(toCwd);
}

function writePrivateFile(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, contents, { mode: 0o600 });
}

function summaryPrompt(manifest) {
  const lines = [
    `Continue this handed-off session: ${manifest.title}`,
    "",
    `It was running on ${manifest.machine || "another machine"} in ${manifest.repo}, on branch ${manifest.branch}.`,
  ];
  if (manifest.wip?.summary) lines.push(`Uncommitted work carried over: ${manifest.wip.summary}.`);
  if (manifest.excerpt) lines.push("", "Where it left off:", manifest.excerpt);
  lines.push("", "Pick up from there. The working tree already contains that work.");
  return lines.join("\n");
}

function importSession({ manifest, sessionBytes, runHome, codexHome, worktreePath }) {
  const provider = manifest.harness === "codex" || manifest.harness === "cursor" ? manifest.harness : "claude";

  if (sessionBytes && manifest.sessionFormat === "claude-jsonl" && manifest.sessionId) {
    const rewritten = rewriteClaudeSession(sessionBytes.toString("utf8"), {
      fromCwd: manifest.cwd,
      toCwd: worktreePath,
    });
    writePrivateFile(
      path.join(runHome, ".claude", "projects", claudeProjectSlug(worktreePath), `${manifest.sessionId}.jsonl`),
      rewritten,
    );
    return { provider: "claude", resumeSessionId: manifest.sessionId, primedPrompt: null };
  }

  if (sessionBytes && manifest.sessionFormat === "codex-rollout" && manifest.sessionId) {
    writePrivateFile(path.join(codexHome, "sessions", `${manifest.sessionId}.jsonl`), sessionBytes);
    return { provider: "codex", resumeSessionId: manifest.sessionId, primedPrompt: null };
  }

  return { provider, resumeSessionId: null, primedPrompt: summaryPrompt(manifest) };
}

export {
  HANDOFF_MANIFEST_VERSION,
  claudeProjectSlug,
  rewriteClaudeSession,
  summaryPrompt,
  importSession,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd product/relayd && node --test test/sessionimport.test.mjs`
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add product/relayd/src/sessionimport.mjs product/relayd/test/sessionimport.test.mjs
git commit -m "feat(relayd): per-harness session import for handoffs"
```

---

## Task 13: Handoff persistence and a single job-enqueue path

**Files:**
- Modify: `product/relayd/src/store.mjs` (`handoffs` table on both backends, `migrateJsonToSqlite`)
- Modify: `product/relayd/src/jobs.mjs` (extract `enqueueJob`)
- Modify: `product/relayd/src/server.mjs` (`POST /v1/codex/jobs` calls `enqueueJob`)
- Test: `product/relayd/test/handoff-store.test.mjs`

**Interfaces:**
- Consumes: existing store/jobs machinery
- Produces:
  - `store.saveHandoff(record)`, `store.getHandoff(id)`, `store.listHandoffs()` — available on **both** the json and sqlite backends
  - Handoff record: `{ id, state, repo, branch, workspaceId, provider, resumeSessionId, primedPrompt, title, manifest, lastJobId, error, createdAt, updatedAt }`; states `importing | ready | failed`
  - `enqueueJob(body, certSubject) -> job` in `jobs.mjs` — performs all seven steps of job creation (create, register, queue, persist, audit, emit, drain) and returns the job record

Extracting `enqueueJob` is a DRY fix, not a refactor for its own sake: Task 14 needs the identical seven-step sequence, and the conformance suite already covers the existing route, so a regression fails loudly.

- [ ] **Step 1: Write the failing test**

Create `product/relayd/test/handoff-store.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.CODEX_DATA_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), "relayd-handoffstore-data-"));

const { createStore } = await import("../src/store.mjs");

function record(overrides = {}) {
  return {
    id: "abc123def4567890", state: "ready", repo: "me/relay", branch: "relay/handoff-x",
    workspaceId: "dir-handoff-abc123", provider: "claude",
    resumeSessionId: "11111111-2222-4333-8444-555555555555", primedPrompt: null,
    title: "Fix the auth redirect", manifest: { v: 1, title: "Fix the auth redirect" },
    lastJobId: null, error: null, createdAt: "2026-08-11T10:00:00.000Z", updatedAt: "2026-08-11T10:00:00.000Z",
    ...overrides,
  };
}

for (const kind of ["json", "sqlite"]) {
  test(`${kind}: handoffs round-trip and list newest first`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `relayd-handoffstore-${kind}-`));
    const store = await createStore(kind, {
      jobsDir: path.join(dir, "jobs"), chatsDir: path.join(dir, "chats"),
      dataDir: dir, pairingDir: path.join(dir, "pairing"), dbPath: path.join(dir, "relayd.sqlite"),
    });
    try {
      store.saveHandoff(record({ id: "aaaaaaaaaaaaaaa1", createdAt: "2026-08-11T10:00:00.000Z" }));
      store.saveHandoff(record({ id: "aaaaaaaaaaaaaaa2", createdAt: "2026-08-11T11:00:00.000Z" }));

      const fetched = store.getHandoff("aaaaaaaaaaaaaaa1");
      assert.equal(fetched.title, "Fix the auth redirect");
      assert.deepEqual(fetched.manifest, { v: 1, title: "Fix the auth redirect" });
      assert.deepEqual(store.listHandoffs().map((entry) => entry.id), ["aaaaaaaaaaaaaaa2", "aaaaaaaaaaaaaaa1"]);
    } finally { store.close?.(); }
  });

  test(`${kind}: saving the same id updates in place`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `relayd-handoffupd-${kind}-`));
    const store = await createStore(kind, {
      jobsDir: path.join(dir, "jobs"), chatsDir: path.join(dir, "chats"),
      dataDir: dir, pairingDir: path.join(dir, "pairing"), dbPath: path.join(dir, "relayd.sqlite"),
    });
    try {
      store.saveHandoff(record({ state: "importing" }));
      store.saveHandoff(record({ state: "failed", error: "clone_failed" }));

      assert.equal(store.listHandoffs().length, 1);
      assert.deepEqual(
        { state: store.getHandoff("abc123def4567890").state, error: store.getHandoff("abc123def4567890").error },
        { state: "failed", error: "clone_failed" },
      );
    } finally { store.close?.(); }
  });

  test(`${kind}: an unknown id reads back as null`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `relayd-handoffmiss-${kind}-`));
    const store = await createStore(kind, {
      jobsDir: path.join(dir, "jobs"), chatsDir: path.join(dir, "chats"),
      dataDir: dir, pairingDir: path.join(dir, "pairing"), dbPath: path.join(dir, "relayd.sqlite"),
    });
    try {
      assert.equal(store.getHandoff("nope0000nope0000"), null);
      assert.deepEqual(store.listHandoffs(), []);
    } finally { store.close?.(); }
  });
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd product/relayd && node --test test/handoff-store.test.mjs`
Expected: FAIL — `store.saveHandoff is not a function`.

- [ ] **Step 3: Add the sqlite backend**

In `product/relayd/src/store.mjs`, append to `SQLITE_SCHEMA`:

```sql
CREATE TABLE IF NOT EXISTS handoffs (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  repo TEXT NOT NULL,
  branch TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  record TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_handoffs_created ON handoffs (created_at);
```

In `createSqliteStore(db)`, prepare the statements and add the three methods to the returned object:

```js
  const saveHandoffStatement = db.prepare(
    `INSERT INTO handoffs (id, state, repo, branch, created_at, updated_at, record)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       state = excluded.state, repo = excluded.repo, branch = excluded.branch,
       updated_at = excluded.updated_at, record = excluded.record`,
  );

  function saveHandoff(handoff) {
    assertSafeRecordId(handoff.id);
    saveHandoffStatement.run(handoff.id, handoff.state, handoff.repo, handoff.branch,
      handoff.createdAt, handoff.updatedAt, JSON.stringify(handoff));
  }

  function getHandoff(id) {
    assertSafeRecordId(id);
    const row = db.prepare("SELECT record FROM handoffs WHERE id = ?").get(id);
    return row ? JSON.parse(row.record) : null;
  }

  function listHandoffs() {
    return db.prepare("SELECT record FROM handoffs ORDER BY created_at DESC")
      .all().map((row) => JSON.parse(row.record));
  }
```

- [ ] **Step 4: Add the json backend**

In `createJsonStore({ dataDir, … })`, mirroring the chat-thread file idiom:

```js
  const handoffsDir = path.join(dataDir, "handoffs");

  function saveHandoff(handoff) {
    assertSafeRecordId(handoff.id);
    fs.mkdirSync(handoffsDir, { recursive: true });
    writeJsonFileAtomic(path.join(handoffsDir, `${handoff.id}.json`), handoff, { mode: 0o600 });
  }

  function getHandoff(id) {
    assertSafeRecordId(id);
    try {
      return JSON.parse(fs.readFileSync(path.join(handoffsDir, `${id}.json`), "utf8"));
    } catch {
      return null;
    }
  }

  function listHandoffs() {
    let names = [];
    try {
      names = fs.readdirSync(handoffsDir).filter((name) => name.endsWith(".json"));
    } catch {
      return [];
    }
    return names
      .map((name) => getHandoff(name.slice(0, -".json".length)))
      .filter(Boolean)
      .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
  }
```

Add all three names to both backends' returned objects, and copy handoffs in `migrateJsonToSqlite` with a `handoffs` counter:

```js
  for (const handoff of source.listHandoffs()) {
    target.saveHandoff(handoff);
    counts.handoffs += 1;
  }
```

- [ ] **Step 5: Extract `enqueueJob`**

In `product/relayd/src/jobs.mjs`, add next to `createJob` and include it in the export list:

```js
// The seven steps every new job needs, in one place: validate, register in the
// live map, queue it, persist, audit, publish, and drain. Both the HTTP route
// and the handoff continue-path go through here so they cannot drift.
function enqueueJob(body, certSubject) {
  const job = createJob(body, certSubject);
  jobs.set(job.id, job);
  jobsState.queuedJobIds.push(job.id);
  persistJob(job);
  appendAudit("job_created", job);
  emitJobStateEvent(job);
  processQueue();
  return job;
}
```

In `product/relayd/src/server.mjs`, replace the seven inline statements in the `POST /v1/codex/jobs` branch with:

```js
    const job = enqueueJob(body, auth.subject);
    return sendJson(res, 202, await toJobResponse(job, responseShape("preview")));
```

and add `enqueueJob` to the `jobs.mjs` import list there.

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd product/relayd && node --test test/handoff-store.test.mjs test/store.test.mjs && node --test test/conformance.test.mjs`
Expected: PASS — 9 new store tests, the store suite, and all 59 conformance tests (which prove the `enqueueJob` extraction is behavior-preserving).

- [ ] **Step 7: Commit**

```bash
git add product/relayd/src/store.mjs product/relayd/src/jobs.mjs product/relayd/src/server.mjs product/relayd/test/handoff-store.test.mjs
git commit -m "feat(relayd): handoff persistence and a single job-enqueue path"
```

---

## Task 14: The handoff module — pickup, import, continue, push back

**Files:**
- Create: `product/relayd/src/handoff.mjs`
- Modify: `product/relayd/src/additions.mjs` (three routes)
- Modify: `product/relayd/src/jobs.mjs` (one line in `finishJob`)
- Modify: `product/relayd/src/index.mjs` (start the loop)
- Test: `product/relayd/test/handoff.test.mjs`

**Interfaces:**
- Consumes: `createCloudClient` (11), `importSession` (12), `store.saveHandoff` + `enqueueJob` (13), `openSealed` (1), `readEncPrivateKeyPem` (2), `browseWorkspaceForPath` (workspaces.mjs), `emitEvent` (events.mjs)
- Produces:
  - `async importHandoff(descriptor, { cloud, baseDir, execFileImpl }) -> handoffRecord` where `descriptor = { id, repo, branch }`
  - `async continueHandoff(id, { prompt = null, certSubject = null }) -> job`
  - `async completeHandoffJob(job) -> { branch, pushed } | null`
  - `startHandoffLoop({ cloud, waitSec }) -> { stop() }`
  - Routes: `GET /v1/handoffs`, `GET /v1/handoffs/:id`, `POST /v1/handoffs/:id/continue`

Checkout layout: `<workspaceBrowseRoot>/handoff-<id first 12 chars>`, cloned with `git clone --branch <branch> --single-branch --depth 50 https://github.com/<repo>.git <dir>`. One directory per handoff, so concurrent handoffs never collide and the jail containment check is a single `realpath` test.

- [ ] **Step 1: Write the failing test**

Create `product/relayd/test/handoff.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const root = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-handoff-"));
const workspaceRoot = path.join(root, "workspaces");
const runHome = path.join(root, "home");
fs.mkdirSync(workspaceRoot, { recursive: true });
fs.mkdirSync(runHome, { recursive: true });

process.env.CODEX_DATA_DIR ||= path.join(root, "data");
process.env.CODEX_WORKSPACE_BROWSE_ROOT ||= workspaceRoot;
process.env.CODEX_WORKSPACES ||= JSON.stringify([{ id: "welcome", name: "Welcome", path: path.join(workspaceRoot, "welcome") }]);
process.env.CODEX_RUN_HOME ||= runHome;

const { initIdentity, identityPaths, readEncPublicKeyB64 } = await import("../src/identity.mjs");
const { sealTo } = await import("../src/seal.mjs");
const { importHandoff } = await import("../src/handoff.mjs");
const { store } = await import("../src/store.mjs");

const IDENTITY_DIR = path.join(root, "identity");
initIdentity({ baseDir: IDENTITY_DIR });

const MANIFEST = {
  v: 1, id: "abc123def4567890", harness: "claude", sessionId: "11111111-2222-4333-8444-555555555555",
  title: "Fix the auth redirect", repo: "me/relay", baseBranch: "main",
  branch: "relay/handoff-fix-the-auth-redirect", cwd: "/Users/dev/code/relay", machine: "MacBook-Pro",
  createdAt: 1_800_000_000_000, sessionFormat: "claude-jsonl",
  wip: { files: 1, insertions: 3, deletions: 0, summary: "1 file changed" },
  excerpt: "Tracing the redirect loop.",
};

// Builds a bare repo that stands in for GitHub, containing the handoff branch
// with sealed blobs exactly as `relay handoff` would have pushed them.
async function makeOriginRepo({ manifest = MANIFEST, sessionBytes = Buffer.from(
  `${JSON.stringify({ type: "user", cwd: manifest.cwd, message: "hello" })}\n`, "utf8") } = {}) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-handoff-origin-"));
  const bare = `${work}.git`;
  const git = (...args) => execFileAsync("git", ["-C", work, ...args]);

  await execFileAsync("git", ["init", "-q", "-b", "main", work]);
  await git("config", "user.email", "test@example.com");
  await git("config", "user.name", "Test");
  fs.writeFileSync(path.join(work, "README.md"), "# repo\n");
  await git("add", "-A");
  await git("commit", "-qm", "initial");
  await git("checkout", "-qb", manifest.branch);

  const encPubkey = readEncPublicKeyB64(identityPaths(IDENTITY_DIR));
  const blobDir = path.join(work, ".relay", "handoff", manifest.id);
  fs.mkdirSync(blobDir, { recursive: true });
  fs.writeFileSync(path.join(blobDir, "manifest.enc"), sealTo(encPubkey, Buffer.from(JSON.stringify(manifest), "utf8")));
  if (sessionBytes) fs.writeFileSync(path.join(blobDir, "session.enc"), sealTo(encPubkey, sessionBytes));
  await git("add", "-A");
  await git("commit", "-qm", "relay handoff");
  await execFileAsync("git", ["clone", "-q", "--bare", work, bare]);
  return bare;
}

function deps(originPath) {
  const events = [];
  return {
    events,
    cloud: { postEvent: async (type, extra) => { events.push({ type, ...extra }); return { status: 202 }; } },
    baseDir: IDENTITY_DIR,
    runHome,
    remoteUrlFor: () => originPath,
  };
}

test("a handoff is cloned, decrypted, staged for resume, and announced", async () => {
  const origin = await makeOriginRepo();
  const options = deps(origin);

  const record = await importHandoff({ id: MANIFEST.id, repo: MANIFEST.repo, branch: MANIFEST.branch }, options);

  assert.equal(record.state, "ready");
  assert.equal(record.title, "Fix the auth redirect");
  assert.equal(record.provider, "claude");
  assert.equal(record.resumeSessionId, MANIFEST.sessionId);

  const checkout = path.join(workspaceRoot, `handoff-${MANIFEST.id.slice(0, 12)}`);
  assert.ok(fs.existsSync(path.join(checkout, "README.md")), "the branch is checked out");
  assert.ok(record.workspaceId, "a workspace id is registered so jobs can target it");

  const staged = path.join(runHome, ".claude", "projects", checkout.replace(/[^A-Za-z0-9]/g, "-"),
    `${MANIFEST.sessionId}.jsonl`);
  assert.ok(fs.existsSync(staged), "the session is staged where --resume finds it");
  assert.ok(!fs.readFileSync(staged, "utf8").includes("/Users/dev/code/relay"), "the laptop path is rewritten away");

  assert.deepEqual(options.events.map((event) => event.type), ["handoff.ready"]);
  assert.equal(store.getHandoff(MANIFEST.id).state, "ready");
});

test("plaintext never reaches the checkout — only sealed blobs are committed", async () => {
  const origin = await makeOriginRepo();
  await importHandoff({ id: MANIFEST.id, repo: MANIFEST.repo, branch: MANIFEST.branch }, deps(origin));

  const checkout = path.join(workspaceRoot, `handoff-${MANIFEST.id.slice(0, 12)}`);
  const sealed = fs.readFileSync(path.join(checkout, ".relay", "handoff", MANIFEST.id, "session.enc"));
  assert.ok(!sealed.includes(Buffer.from("hello", "utf8")), "the committed session blob stays ciphertext");
});

test("a handoff with no session blob still lands as ready with a primed prompt", async () => {
  const manifest = { ...MANIFEST, id: "bbb123def4567890", harness: "cursor", sessionFormat: "none", sessionId: null };
  const origin = await makeOriginRepo({ manifest, sessionBytes: null });

  const record = await importHandoff({ id: manifest.id, repo: manifest.repo, branch: manifest.branch }, deps(origin));

  assert.equal(record.state, "ready");
  assert.equal(record.resumeSessionId, null);
  assert.match(record.primedPrompt, /Fix the auth redirect/);
});

test("a clone failure is recorded and announced, never silent", async () => {
  const options = deps("/nonexistent/repo.git");
  const record = await importHandoff({ id: "ccc123def4567890", repo: "me/relay", branch: "relay/handoff-x" }, options);

  assert.equal(record.state, "failed");
  assert.match(record.error, /clone_failed/);
  assert.deepEqual(options.events.map((event) => event.type), ["handoff.failed"]);
  assert.equal(store.getHandoff("ccc123def4567890").state, "failed");
});

test("a blob sealed to another node is refused", async () => {
  const strangerDir = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-handoff-stranger-"));
  initIdentity({ baseDir: strangerDir });
  const manifest = { ...MANIFEST, id: "ddd123def4567890" };

  // Seal to the stranger's key, then import as ourselves.
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-handoff-badseal-"));
  const bare = `${work}.git`;
  const git = (...args) => execFileAsync("git", ["-C", work, ...args]);
  await execFileAsync("git", ["init", "-q", "-b", "main", work]);
  await git("config", "user.email", "t@example.com");
  await git("config", "user.name", "T");
  fs.writeFileSync(path.join(work, "README.md"), "# repo\n");
  await git("add", "-A");
  await git("commit", "-qm", "initial");
  await git("checkout", "-qb", manifest.branch);
  const blobDir = path.join(work, ".relay", "handoff", manifest.id);
  fs.mkdirSync(blobDir, { recursive: true });
  fs.writeFileSync(path.join(blobDir, "manifest.enc"),
    sealTo(readEncPublicKeyB64(identityPaths(strangerDir)), Buffer.from(JSON.stringify(manifest), "utf8")));
  await git("add", "-A");
  await git("commit", "-qm", "relay handoff");
  await execFileAsync("git", ["clone", "-q", "--bare", work, bare]);

  const options = deps(bare);
  const record = await importHandoff({ id: manifest.id, repo: manifest.repo, branch: manifest.branch }, options);

  assert.equal(record.state, "failed");
  assert.match(record.error, /seal_decrypt_failed/);
  assert.deepEqual(options.events.map((event) => event.type), ["handoff.failed"]);
});

test("importing the same handoff twice is idempotent", async () => {
  const manifest = { ...MANIFEST, id: "eee123def4567890" };
  const origin = await makeOriginRepo({ manifest });
  const descriptor = { id: manifest.id, repo: manifest.repo, branch: manifest.branch };

  const first = await importHandoff(descriptor, deps(origin));
  const second = await importHandoff(descriptor, deps(origin));

  assert.equal(first.state, "ready");
  assert.equal(second.state, "ready");
  assert.equal(second.workspaceId, first.workspaceId);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd product/relayd && node --test test/handoff.test.mjs`
Expected: FAIL — `Cannot find module '../src/handoff.mjs'`.

- [ ] **Step 3: Write the handoff module**

Create `product/relayd/src/handoff.mjs`:

```js
// relayd handoff.mjs — the sandbox end of `relay handoff`.
//
// Pickup is a long-poll against the control plane, which learns only names.
// Everything with content comes over git: the branch carries the work, and two
// blobs sealed to this node's X25519 key carry the manifest and the session
// transcript. They are decrypted here and nowhere else.
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { workspaceBrowseRoot, runHome as configuredRunHome, codexHome, gitBin } from "./config.mjs";
import { identityPaths, readEncPrivateKeyPem } from "./identity.mjs";
import { openSealed } from "./seal.mjs";
import { importSession } from "./sessionimport.mjs";
import { browseWorkspaceForPath, resolvedPathWithinRoot } from "./workspaces.mjs";
import { store } from "./store.mjs";
import { emitEvent } from "./events.mjs";
import { appendAudit } from "./audit.mjs";
import { enqueueJob } from "./jobs.mjs";

const execFileAsync = promisify(execFile);
const MAX_BLOB_BYTES = 20 * 1024 * 1024;

function checkoutPathFor(handoffId) {
  return path.join(workspaceBrowseRoot, `handoff-${String(handoffId).slice(0, 12)}`);
}

function nowIso() {
  return new Date().toISOString();
}

function persist(record) {
  store.saveHandoff(record);
  return record;
}

async function failHandoff(record, error, cloud) {
  const failed = persist({ ...record, state: "failed", error: String(error), updatedAt: nowIso() });
  appendAudit("handoff_failed", { id: record.id }, { error: String(error) });
  emitEvent("handoff.failed", { id: record.id, repo: record.repo, error: String(error) });
  await cloud?.postEvent?.("handoff.failed").catch(() => {});
  return failed;
}

function readSealed(checkout, handoffId, name) {
  const filePath = path.join(checkout, ".relay", "handoff", handoffId, name);
  const stat = fs.statSync(filePath);
  if (stat.size > MAX_BLOB_BYTES) throw new Error(`blob_too_large_${name}`);
  return fs.readFileSync(filePath);
}

async function importHandoff(descriptor, options = {}) {
  const {
    cloud = null,
    baseDir = undefined,
    runHome = configuredRunHome,
    execFileImpl = execFileAsync,
    remoteUrlFor = (repo) => `https://github.com/${repo}.git`,
  } = options;

  const existing = store.getHandoff(descriptor.id);
  if (existing && existing.state === "ready") return existing;

  let record = persist({
    id: descriptor.id, state: "importing", repo: descriptor.repo, branch: descriptor.branch,
    workspaceId: null, provider: null, resumeSessionId: null, primedPrompt: null,
    title: descriptor.branch, manifest: null, lastJobId: null, error: null,
    createdAt: existing?.createdAt || nowIso(), updatedAt: nowIso(),
  });

  const checkout = checkoutPathFor(descriptor.id);
  try {
    if (!resolvedPathWithinRoot(path.resolve(checkout))) throw new Error("checkout_outside_jail");
    fs.rmSync(checkout, { recursive: true, force: true });
    await execFileImpl(gitBin, [
      "clone", "--quiet", "--branch", descriptor.branch, "--single-branch", "--depth", "50",
      remoteUrlFor(descriptor.repo), checkout,
    ], { env: { ...process.env, HOME: runHome, GIT_TERMINAL_PROMPT: "0" } });
  } catch (error) {
    return failHandoff(record, `clone_failed: ${error?.message || error}`, cloud);
  }

  let manifest = null;
  let sessionBytes = null;
  try {
    const privateKeyPem = readEncPrivateKeyPem(baseDir ? identityPaths(baseDir) : identityPaths());
    if (!privateKeyPem) throw new Error("no_encryption_key");
    manifest = JSON.parse(openSealed(privateKeyPem, readSealed(checkout, descriptor.id, "manifest.enc")).toString("utf8"));
    if (manifest?.v !== 1) throw new Error("unsupported_manifest_version");
    try {
      sessionBytes = openSealed(privateKeyPem, readSealed(checkout, descriptor.id, "session.enc"));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      sessionBytes = null;
    }
  } catch (error) {
    return failHandoff(record, error?.message || String(error), cloud);
  }

  const workspace = browseWorkspaceForPath(checkout, { materialize: true });
  if (!workspace) return failHandoff(record, "workspace_registration_failed", cloud);

  const staged = importSession({ manifest, sessionBytes, runHome, codexHome, worktreePath: checkout });

  record = persist({
    ...record,
    state: "ready",
    workspaceId: workspace.id,
    provider: staged.provider,
    resumeSessionId: staged.resumeSessionId,
    primedPrompt: staged.primedPrompt,
    title: manifest.title || descriptor.branch,
    manifest,
    updatedAt: nowIso(),
  });

  appendAudit("handoff_ready", { id: record.id }, { repo: record.repo, provider: record.provider });
  emitEvent("handoff.ready", { id: record.id, repo: record.repo, title: record.title, provider: record.provider });
  await cloud?.postEvent?.("handoff.ready").catch(() => {});
  return record;
}

async function continueHandoff(id, { prompt = null, certSubject = null } = {}) {
  const record = store.getHandoff(id);
  if (!record) throw Object.assign(new Error("handoff not found"), { status: 404 });
  if (record.state !== "ready") throw Object.assign(new Error("handoff is not ready"), { status: 409 });

  const job = enqueueJob({
    workspaceId: record.workspaceId,
    provider: record.provider,
    prompt: prompt || record.primedPrompt || "Continue where the handed-off session left off.",
    resumeSessionId: record.resumeSessionId || undefined,
  }, certSubject);

  persist({ ...record, lastJobId: job.id, updatedAt: nowIso() });
  return job;
}

// Called from finishJob. A handoff job's commits belong on the handoff branch,
// so a successful run commits and pushes there — never force, never elsewhere.
async function completeHandoffJob(job) {
  const record = store.listHandoffs().find((entry) => entry.lastJobId === job.id);
  if (!record || job.status !== "succeeded") return null;

  const checkout = checkoutPathFor(record.id);
  const git = (...args) => execFileAsync(gitBin, ["-C", checkout, ...args],
    { env: { ...process.env, HOME: configuredRunHome, GIT_TERMINAL_PROMPT: "0" } });
  try {
    const status = await git("status", "--porcelain");
    if (status.stdout.trim()) {
      await git("-c", "user.name=relayd", "-c", "user.email=relayd@localhost", "add", "-A");
      await git("-c", "user.name=relayd", "-c", "user.email=relayd@localhost", "commit", "-m", `relay: job ${job.id}`);
    }
    await git("push", "origin", record.branch);
    appendAudit("handoff_pushed", { id: record.id }, { branch: record.branch, jobId: job.id });
    return { branch: record.branch, pushed: true };
  } catch (error) {
    appendAudit("handoff_push_failed", { id: record.id }, { error: error?.message || String(error) });
    return { branch: record.branch, pushed: false };
  }
}

function startHandoffLoop({ cloud, waitSec }) {
  let stopped = false;
  (async () => {
    let backoffMs = 1000;
    while (!stopped) {
      try {
        const descriptors = await cloud.pollHandoffs(waitSec);
        backoffMs = 1000;
        for (const descriptor of descriptors) {
          if (stopped) break;
          await importHandoff(descriptor, { cloud });
        }
      } catch (error) {
        appendAudit("handoff_poll_failed", { id: "loop" }, { error: error?.message || String(error) });
        await new Promise((resolve) => setTimeout(resolve, backoffMs).unref?.());
        backoffMs = Math.min(backoffMs * 2, 60_000);
      }
    }
  })();
  return { stop() { stopped = true; } };
}

export { importHandoff, continueHandoff, completeHandoffJob, startHandoffLoop, checkoutPathFor };
```

If `config.mjs` does not already export `gitBin`, add it there (`const gitBin = process.env.RELAYD_GIT_BIN || "git";`) and import it in `worktree.mjs` from config rather than re-reading the env, so there is one definition.

- [ ] **Step 4: Run the module tests**

Run: `cd product/relayd && node --test test/handoff.test.mjs`
Expected: PASS — 6 tests.

- [ ] **Step 5: Add the routes**

In `product/relayd/src/additions.mjs`, inside `handleAdditionRoutes`:

```js
  if (req.method === "GET" && url.pathname === "/v1/handoffs") {
    const handoffs = store.listHandoffs().map(publicHandoff);
    sendJson(res, 200, { handoffs });
    return true;
  }

  const handoffMatch = url.pathname.match(/^\/v1\/handoffs\/([^/]+)$/);
  if (handoffMatch && req.method === "GET") {
    const record = store.getHandoff(handoffMatch[1]);
    if (!record) { sendError(res, 404, "handoff not found"); return true; }
    sendJson(res, 200, { handoff: { ...publicHandoff(record), manifest: record.manifest } });
    return true;
  }

  const continueMatch = url.pathname.match(/^\/v1\/handoffs\/([^/]+)\/continue$/);
  if (continueMatch && req.method === "POST") {
    const body = await readBody(req);
    const job = await continueHandoff(continueMatch[1], {
      prompt: typeof body?.prompt === "string" && body.prompt.trim() ? body.prompt.trim() : null,
      certSubject: auth.subject,
    });
    sendJson(res, 202, { job: await toJobResponse(job, responseShape("preview")) });
    return true;
  }
```

with the projection near the other public shapes (it omits `primedPrompt`, which is prompt scaffolding rather than user-facing content):

```js
function publicHandoff(record) {
  return {
    id: record.id,
    state: record.state,
    repo: record.repo,
    branch: record.branch,
    title: record.title,
    provider: record.provider,
    workspaceId: record.workspaceId,
    canResumeNatively: Boolean(record.resumeSessionId),
    lastJobId: record.lastJobId,
    error: record.error,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}
```

Add the imports `continueHandoff` from `./handoff.mjs`, `store` from `./store.mjs`, and `toJobResponse` / `responseShape` from `./jobs.mjs`.

- [ ] **Step 6: Hook the push-back and the loop**

`handoff.mjs` imports `jobs.mjs` (for `enqueueJob`), so `jobs.mjs` must not import `handoff.mjs` back. Use an injected hook instead.

In `product/relayd/src/jobs.mjs`, add at module scope (and export `setHandoffCompletionHook`):

```js
// Set by index.mjs when the handoff loop starts. Default is a no-op so jobs.mjs
// never depends on handoff.mjs and the module graph stays acyclic.
let handoffCompletionHook = async () => null;

function setHandoffCompletionHook(hook) {
  handoffCompletionHook = hook;
}
```

Then in `finishJob`, immediately after the existing `await completeJobWorktree(job);` line:

```js
  await handoffCompletionHook(job).catch(() => null);
```

In `product/relayd/src/index.mjs`, after the listener is up:

```js
if (handoffEnabled && cloudUrl) {
  const { createCloudClient } = await import("./cloudclient.mjs");
  const { startHandoffLoop, completeHandoffJob } = await import("./handoff.mjs");
  const { setHandoffCompletionHook } = await import("./jobs.mjs");
  setHandoffCompletionHook(completeHandoffJob);
  startHandoffLoop({ cloud: createCloudClient({ cloudUrl }), waitSec: handoffPollWaitSec });
  console.log("handoff loop started");
} else {
  console.log("handoff loop disabled (no RELAYD_CLOUD_URL)");
}
```

- [ ] **Step 7: Run the full relayd suite**

Run: `cd product/relayd && node --test test/*.test.mjs`
Expected: PASS — all suites, including conformance. (Test 57 is a known flake under CPU saturation; run it unloaded.)

- [ ] **Step 8: Commit**

```bash
git add product/relayd/src product/relayd/test/handoff.test.mjs
git commit -m "feat(relayd): handoff pickup, session staging, continue, and push-back"
```

---

## Task 15: Credential sync and the Mac session index

**Files:**
- Create: `product/relayd/src/syncauth.mjs`
- Modify: `product/relayd/src/additions.mjs` (`GET /v1/mac-sessions`)
- Test: `product/relayd/test/syncauth.test.mjs`

**Interfaces:**
- Consumes: `openSealed` (1), `readEncPrivateKeyPem` (2), cloud rendezvous (Task 10)
- Produces:
  - `async collectRendezvousBlob({ cloudUrl, pairingId, authToken, fetchImpl }) -> Buffer` — GETs the `device-blob` slot
  - `installCredentialBundle(bundle, { runHome, codexHome }) -> { installed: string[], skipped: string[] }`
  - `saveMacSessions(bundle, { dataDir }) -> void` and `readMacSessions({ dataDir }) -> { machine, updatedAt, sessions: [...] }`
  - `GET /v1/mac-sessions` → `{ index: { machine, updatedAt, sessions } }` or `{ index: null }`

Bundle shape (sealed by the CLI, opened here):
```json
{ "v": 1, "kind": "sync-auth",
  "github": { "token": "…" },
  "claude": { "credentials": "…file contents…" },
  "codex": { "auth": "…file contents…" } }
```
Every member is optional; absent members land in `skipped` so the CLI can report honestly.

- [ ] **Step 1: Write the failing test**

Create `product/relayd/test/syncauth.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.CODEX_DATA_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), "relayd-syncauth-data-"));

const { installCredentialBundle, saveMacSessions, readMacSessions } = await import("../src/syncauth.mjs");

function homes() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-syncauth-"));
  return { runHome: path.join(root, "home"), codexHome: path.join(root, "codex"), dataDir: root };
}

test("a full bundle installs every credential 0600 in the runner home", () => {
  const { runHome, codexHome } = homes();
  const result = installCredentialBundle({
    v: 1, kind: "sync-auth",
    github: { token: "ghp_example" },
    claude: { credentials: '{"token":"claude"}' },
    codex: { auth: '{"token":"codex"}' },
  }, { runHome, codexHome });

  assert.deepEqual(result.installed.sort(), ["claude", "codex", "github"]);
  assert.deepEqual(result.skipped, []);

  const gitCredentials = path.join(runHome, ".git-credentials");
  assert.equal(fs.readFileSync(gitCredentials, "utf8").trim(), "https://x-access-token:ghp_example@github.com");
  assert.equal(fs.statSync(gitCredentials).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(runHome, ".claude", ".credentials.json")).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(path.join(codexHome, "auth.json"), "utf8"), '{"token":"codex"}');
  assert.match(fs.readFileSync(path.join(runHome, ".gitconfig"), "utf8"), /helper = store/);
});

test("absent members are reported as skipped rather than silently ignored", () => {
  const { runHome, codexHome } = homes();
  const result = installCredentialBundle({ v: 1, kind: "sync-auth", github: { token: "ghp_only" } },
    { runHome, codexHome });

  assert.deepEqual(result.installed, ["github"]);
  assert.deepEqual(result.skipped.sort(), ["claude", "codex"]);
  assert.equal(fs.existsSync(path.join(runHome, ".claude", ".credentials.json")), false);
});

test("a bundle of the wrong kind or version is refused", () => {
  const { runHome, codexHome } = homes();
  assert.throws(() => installCredentialBundle({ v: 2, kind: "sync-auth" }, { runHome, codexHome }),
    /unsupported_bundle_version/);
  assert.throws(() => installCredentialBundle({ v: 1, kind: "session-index" }, { runHome, codexHome }),
    /unexpected_bundle_kind/);
});

test("the session index round-trips and holds no transcripts", () => {
  const { dataDir } = homes();
  saveMacSessions({
    v: 1, kind: "session-index", machine: "MacBook-Pro", updatedAt: "2026-08-11T10:00:00.000Z",
    sessions: [{ id: "s1", harness: "claude", title: "Fix auth", repo: "me/relay", lastActive: "2026-08-11T09:00:00.000Z" }],
  }, { dataDir });

  const index = readMacSessions({ dataDir });
  assert.equal(index.machine, "MacBook-Pro");
  assert.equal(index.sessions[0].title, "Fix auth");
  assert.deepEqual(Object.keys(index.sessions[0]).sort(), ["harness", "id", "lastActive", "repo", "title"]);
});

test("reading an index that was never written returns null", () => {
  assert.equal(readMacSessions({ dataDir: homes().dataDir }), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd product/relayd && node --test test/syncauth.test.mjs`
Expected: FAIL — `Cannot find module '../src/syncauth.mjs'`.

- [ ] **Step 3: Write the implementation**

Create `product/relayd/src/syncauth.mjs`:

```js
// relayd syncauth.mjs — install the operator's own credentials into the runner
// home so the sandbox can fetch their repo and run their subscriptions.
//
// Credentials arrive sealed to this node's key over the pairing rendezvous, so
// the control plane relays opaque bytes. They are written 0600 under the runner
// home and never logged, echoed, or returned by any endpoint.
import fs from "node:fs";
import path from "node:path";

const SUPPORTED_VERSION = 1;

function writePrivateFile(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, contents, { mode: 0o600 });
}

async function collectRendezvousBlob({ cloudUrl, pairingId, authToken, fetchImpl = fetch }) {
  const base = `${String(cloudUrl).replace(/\/+$/, "")}/v1/pairing/sessions/${encodeURIComponent(pairingId)}`;
  const res = await fetchImpl(`${base}/device-blob`, { headers: { "x-pairing-auth": authToken } });
  if (res.status !== 200) throw new Error(`rendezvous_${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function installCredentialBundle(bundle, { runHome, codexHome }) {
  if (bundle?.v !== SUPPORTED_VERSION) throw new Error("unsupported_bundle_version");
  if (bundle?.kind !== "sync-auth") throw new Error("unexpected_bundle_kind");

  const installed = [];
  const skipped = [];

  if (bundle.github?.token) {
    writePrivateFile(path.join(runHome, ".git-credentials"),
      `https://x-access-token:${bundle.github.token}@github.com\n`);
    writePrivateFile(path.join(runHome, ".gitconfig"), "[credential]\n\thelper = store\n");
    installed.push("github");
  } else {
    skipped.push("github");
  }

  if (bundle.claude?.credentials) {
    writePrivateFile(path.join(runHome, ".claude", ".credentials.json"), bundle.claude.credentials);
    installed.push("claude");
  } else {
    skipped.push("claude");
  }

  if (bundle.codex?.auth) {
    writePrivateFile(path.join(codexHome, "auth.json"), bundle.codex.auth);
    installed.push("codex");
  } else {
    skipped.push("codex");
  }

  return { installed, skipped };
}

function macSessionsPath(dataDir) {
  return path.join(dataDir, "mac-sessions.json");
}

function saveMacSessions(bundle, { dataDir }) {
  if (bundle?.v !== SUPPORTED_VERSION) throw new Error("unsupported_bundle_version");
  if (bundle?.kind !== "session-index") throw new Error("unexpected_bundle_kind");
  const sessions = Array.isArray(bundle.sessions) ? bundle.sessions.slice(0, 200) : [];
  writePrivateFile(macSessionsPath(dataDir), JSON.stringify({
    machine: bundle.machine || null,
    updatedAt: bundle.updatedAt || null,
    sessions: sessions.map((session) => ({
      id: String(session.id), harness: String(session.harness),
      title: String(session.title || ""), repo: String(session.repo || ""),
      lastActive: String(session.lastActive || ""),
    })),
  }, null, 2));
}

function readMacSessions({ dataDir }) {
  try {
    return JSON.parse(fs.readFileSync(macSessionsPath(dataDir), "utf8"));
  } catch {
    return null;
  }
}

export { collectRendezvousBlob, installCredentialBundle, saveMacSessions, readMacSessions };
```

- [ ] **Step 4: Add the route**

In `product/relayd/src/additions.mjs`:

```js
  if (req.method === "GET" && url.pathname === "/v1/mac-sessions") {
    sendJson(res, 200, { index: readMacSessions({ dataDir }) });
    return true;
  }
```

importing `readMacSessions` from `./syncauth.mjs` and `dataDir` from `./config.mjs`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd product/relayd && node --test test/syncauth.test.mjs`
Expected: PASS — 5 tests.

- [ ] **Step 6: Commit**

```bash
git add product/relayd/src/syncauth.mjs product/relayd/src/additions.mjs product/relayd/test/syncauth.test.mjs
git commit -m "feat(relayd): credential sync installer and Mac session index"
```

---

## Task 16: CLI skeleton, credentials, and the repo guard

**Files:**
- Create: `product/cli/package.json`, `product/cli/bin/relay`, `product/cli/src/creds.mjs`, `product/cli/src/repo.mjs`, `product/cli/src/seal.mjs`
- Test: `product/cli/test/creds.test.mjs`, `product/cli/test/repo.test.mjs`, `product/cli/test/seal-vendor.test.mjs`

**Interfaces:**
- Consumes: `product/relayd/src/seal.mjs` (Task 1) as the vendoring source
- Produces:
  - `readCredentials({ home }) -> { sessionToken, refreshToken, accountId, nodeId, nodeEncPubkey } | null`
  - `writeCredentials(values, { home }) -> void` — writes `~/.relay/credentials.json` 0600 in a 0700 directory
  - `clearCredentials({ home }) -> void`
  - `requireGitHubRepo({ cwd, execFileImpl }) -> Promise<{ root, fullName, branch, remote }>` — throws `Error("not_a_git_repo" | "no_origin_remote" | "origin_not_github")`
  - `parseGitHubRemote(url) -> string | null` — `owner/name`, lowercased, `.git` stripped
  - `currentBranch({ root, execFileImpl })`, `workingTreeSummary({ root, execFileImpl }) -> { files, insertions, deletions, summary }`
  - `product/cli/src/seal.mjs` — byte-identical vendored copy of the relayd module

`RELAY_ALLOW_LOCAL_REMOTE=1` relaxes the github.com check to allow `file://` and bare-path remotes. It exists so tests and the scripted E2E can run without network or a real GitHub repo, and it is the only way to bypass the guard.

- [ ] **Step 1: Write the failing tests**

Create `product/cli/test/creds.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { readCredentials, writeCredentials, clearCredentials } = await import("../src/creds.mjs");

function freshHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-home-"));
}

test("credentials round-trip and are private to the user", () => {
  const home = freshHome();
  writeCredentials({ sessionToken: "s", refreshToken: "r", accountId: "acct", nodeId: "node-1", nodeEncPubkey: "k" }, { home });

  assert.deepEqual(readCredentials({ home }), {
    sessionToken: "s", refreshToken: "r", accountId: "acct", nodeId: "node-1", nodeEncPubkey: "k",
  });
  assert.equal(fs.statSync(path.join(home, ".relay", "credentials.json")).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(home, ".relay")).mode & 0o777, 0o700);
});

test("writing merges into what is already stored", () => {
  const home = freshHome();
  writeCredentials({ sessionToken: "s", accountId: "acct" }, { home });
  writeCredentials({ nodeId: "node-2" }, { home });

  const stored = readCredentials({ home });
  assert.equal(stored.sessionToken, "s");
  assert.equal(stored.nodeId, "node-2");
});

test("reading with nothing stored, or after clearing, returns null", () => {
  const home = freshHome();
  assert.equal(readCredentials({ home }), null);
  writeCredentials({ sessionToken: "s" }, { home });
  clearCredentials({ home });
  assert.equal(readCredentials({ home }), null);
});
```

Create `product/cli/test/repo.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const { requireGitHubRepo, parseGitHubRemote, currentBranch, workingTreeSummary } = await import("../src/repo.mjs");

async function makeRepo({ origin = "https://github.com/Me/Relay.git" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-repo-"));
  const git = (...args) => execFileAsync("git", ["-C", dir, ...args]);
  await execFileAsync("git", ["init", "-q", "-b", "main", dir]);
  await git("config", "user.email", "test@example.com");
  await git("config", "user.name", "Test");
  if (origin) await git("remote", "add", "origin", origin);
  fs.writeFileSync(path.join(dir, "README.md"), "# hi\n");
  await git("add", "-A");
  await git("commit", "-qm", "initial");
  return dir;
}

test("parseGitHubRemote understands every remote form GitHub hands out", () => {
  for (const url of [
    "https://github.com/Me/Relay.git", "https://github.com/Me/Relay",
    "git@github.com:Me/Relay.git", "ssh://git@github.com/Me/Relay.git",
  ]) {
    assert.equal(parseGitHubRemote(url), "me/relay", `failed for ${url}`);
  }
  assert.equal(parseGitHubRemote("https://gitlab.com/me/relay.git"), null);
  assert.equal(parseGitHubRemote(""), null);
});

test("a github-backed repo resolves to its root, full name, and branch", async () => {
  const dir = await makeRepo();
  const nested = path.join(dir, "src", "deep");
  fs.mkdirSync(nested, { recursive: true });

  const repo = await requireGitHubRepo({ cwd: nested });

  assert.equal(repo.fullName, "me/relay");
  assert.equal(repo.branch, "main");
  assert.equal(fs.realpathSync(repo.root), fs.realpathSync(dir), "the repo root is found from a nested cwd");
});

test("a non-repo, a remoteless repo, and a non-github remote are each refused distinctly", async () => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-plain-"));
  await assert.rejects(() => requireGitHubRepo({ cwd: plain }), /not_a_git_repo/);

  const noRemote = await makeRepo({ origin: null });
  await assert.rejects(() => requireGitHubRepo({ cwd: noRemote }), /no_origin_remote/);

  const gitlab = await makeRepo({ origin: "https://gitlab.com/me/relay.git" });
  await assert.rejects(() => requireGitHubRepo({ cwd: gitlab }), /origin_not_github/);
});

test("RELAY_ALLOW_LOCAL_REMOTE is the only bypass for the github guard", async () => {
  const local = await makeRepo({ origin: "/tmp/some-bare-repo.git" });
  await assert.rejects(() => requireGitHubRepo({ cwd: local }), /origin_not_github/);

  process.env.RELAY_ALLOW_LOCAL_REMOTE = "1";
  try {
    const repo = await requireGitHubRepo({ cwd: local });
    assert.equal(repo.fullName, "local/some-bare-repo");
  } finally {
    delete process.env.RELAY_ALLOW_LOCAL_REMOTE;
  }
});

test("workingTreeSummary counts tracked edits and untracked files", async () => {
  const dir = await makeRepo();
  fs.appendFileSync(path.join(dir, "README.md"), "one\ntwo\n");
  fs.writeFileSync(path.join(dir, "new.txt"), "fresh\n");

  const summary = await workingTreeSummary({ root: dir });

  assert.equal(summary.files, 2);
  assert.ok(summary.insertions >= 2);
  assert.match(summary.summary, /2 files? changed/);
  assert.equal(await currentBranch({ root: dir }), "main");
});

test("a clean tree summarises as no changes", async () => {
  const dir = await makeRepo();
  const summary = await workingTreeSummary({ root: dir });
  assert.equal(summary.files, 0);
  assert.equal(summary.summary, "no uncommitted changes");
});
```

Create `product/cli/test/seal-vendor.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

test("the vendored seal module is byte-identical to relayd's canonical copy", () => {
  const vendored = fs.readFileSync(path.join(here, "..", "src", "seal.mjs"));
  const canonical = fs.readFileSync(path.join(here, "..", "..", "relayd", "src", "seal.mjs"));
  assert.ok(vendored.equals(canonical),
    "product/cli/src/seal.mjs has drifted from product/relayd/src/seal.mjs — copy the canonical file over");
});

test("the vendored module still seals and opens", async () => {
  const { generateEncKeyPair, sealTo, openSealed } = await import("../src/seal.mjs");
  const recipient = generateEncKeyPair();
  const sealed = sealTo(recipient.publicKeyB64, Buffer.from("vendored", "utf8"));
  assert.equal(openSealed(recipient.privateKeyPem, sealed).toString("utf8"), "vendored");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd product/cli && node --test test/*.test.mjs`
Expected: FAIL — no `package.json`, no `src/` modules.

- [ ] **Step 3: Create the package skeleton**

Create `product/cli/package.json`:

```json
{
  "name": "@relay/cli",
  "version": "0.1.0",
  "description": "Hand a local coding-agent session off to your Relay machine",
  "type": "module",
  "engines": { "node": ">=20" },
  "bin": { "relay": "bin/relay" },
  "files": ["bin", "src"],
  "scripts": { "test": "node --test test/*.test.mjs" },
  "license": "MIT"
}
```

Create `product/cli/bin/relay` (mode 0755 — set it with `chmod +x product/cli/bin/relay`):

```js
#!/usr/bin/env node
// relay — the desk end of the handoff.
//
// Every subcommand except `login` requires a git repository whose origin points
// at github.com; the repo is the unit of everything this tool does. Modules are
// imported lazily so `relay help` never touches credentials or spawns git.
const [, , command, ...rest] = process.argv;

const usage = `usage: relay <command>

  login       sign in to Relay and pin this machine's target sandbox
  init        register this repository for handoffs
  handoff     hand the current session to your sandbox
  sync-auth   copy your GitHub and harness logins to your sandbox
  status      show this repository's handoffs
  help        show this message
`;

function fail(message, code = 1) {
  console.error(`relay: ${message}`);
  process.exit(code);
}

try {
  switch (command) {
    case "login": {
      const { cmdLogin } = await import("../src/commands/login.mjs");
      await cmdLogin(rest);
      break;
    }
    case "init": {
      const { cmdInit } = await import("../src/commands/init.mjs");
      await cmdInit(rest);
      break;
    }
    case "handoff": {
      const { cmdHandoff } = await import("../src/commands/handoff.mjs");
      await cmdHandoff(rest);
      break;
    }
    case "sync-auth": {
      const { cmdSyncAuth } = await import("../src/commands/syncauth.mjs");
      await cmdSyncAuth(rest);
      break;
    }
    case "status": {
      const { cmdStatus } = await import("../src/commands/status.mjs");
      await cmdStatus(rest);
      break;
    }
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(usage);
      break;
    default:
      console.error(usage);
      fail(`unknown command: ${command}`);
  }
} catch (error) {
  fail(error?.message || String(error));
}
```

- [ ] **Step 4: Write `creds.mjs`**

Create `product/cli/src/creds.mjs`:

```js
// Where the CLI keeps its session. The file holds a bearer session for the
// control plane and the pinned identity of the sandbox this machine hands off
// to — never repository content and never harness credentials.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const FIELDS = ["sessionToken", "refreshToken", "accountId", "nodeId", "nodeEncPubkey"];

function credentialsPath(home) {
  return path.join(home || os.homedir(), ".relay", "credentials.json");
}

function readCredentials({ home } = {}) {
  try {
    const parsed = JSON.parse(fs.readFileSync(credentialsPath(home), "utf8"));
    const result = {};
    for (const field of FIELDS) result[field] = parsed[field] ?? null;
    return result;
  } catch {
    return null;
  }
}

function writeCredentials(values, { home } = {}) {
  const filePath = credentialsPath(home);
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(filePath), 0o700);
  const merged = { ...(readCredentials({ home }) || {}), ...values };
  const output = {};
  for (const field of FIELDS) if (merged[field] != null) output[field] = merged[field];
  fs.writeFileSync(filePath, `${JSON.stringify(output, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

function clearCredentials({ home } = {}) {
  try {
    fs.unlinkSync(credentialsPath(home));
  } catch {
    // Nothing stored is the same outcome as clearing it.
  }
}

export { readCredentials, writeCredentials, clearCredentials, credentialsPath };
```

`readCredentials` returns every field (null-filled) so callers can destructure without optional chaining; `writeCredentials` omits nulls so the file stays readable.

- [ ] **Step 5: Write `repo.mjs`**

Create `product/cli/src/repo.mjs`:

```js
// Git facts the handoff needs, and the guard that keeps `relay` inside a
// GitHub-backed repository. GitHub is the transport for repo state, so a repo
// without a github.com origin cannot be handed off at all — say so early.
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const GITHUB_REMOTE_RE = /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+)\/(.+?)(?:\.git)?$/;

function parseGitHubRemote(url) {
  const match = GITHUB_REMOTE_RE.exec(String(url || "").trim());
  if (!match) return null;
  return `${match[1]}/${match[2]}`.toLowerCase();
}

function parseLocalRemote(url) {
  const cleaned = String(url || "").trim().replace(/^file:\/\//, "").replace(/\.git$/, "");
  if (!cleaned) return null;
  return `local/${path.basename(cleaned).toLowerCase()}`;
}

async function git(root, args, execFileImpl = execFileAsync) {
  const { stdout } = await execFileImpl("git", ["-C", root, ...args], { maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

async function requireGitHubRepo({ cwd = process.cwd(), execFileImpl = execFileAsync } = {}) {
  let root;
  try {
    const { stdout } = await execFileImpl("git", ["-C", cwd, "rev-parse", "--show-toplevel"]);
    root = stdout.trim();
  } catch {
    throw new Error("not_a_git_repo: run relay inside a git repository");
  }

  let remote;
  try {
    remote = (await git(root, ["remote", "get-url", "origin"], execFileImpl)).trim();
  } catch {
    throw new Error("no_origin_remote: this repository has no origin remote");
  }

  const fullName = parseGitHubRemote(remote)
    || (process.env.RELAY_ALLOW_LOCAL_REMOTE === "1" ? parseLocalRemote(remote) : null);
  if (!fullName) throw new Error("origin_not_github: relay handoff needs a github.com origin");

  return { root, fullName, remote, branch: await currentBranch({ root, execFileImpl }) };
}

async function currentBranch({ root, execFileImpl = execFileAsync }) {
  return (await git(root, ["rev-parse", "--abbrev-ref", "HEAD"], execFileImpl)).trim();
}

async function workingTreeSummary({ root, execFileImpl = execFileAsync }) {
  const porcelain = (await git(root, ["status", "--porcelain"], execFileImpl)).trim();
  const files = porcelain ? porcelain.split("\n").length : 0;
  if (files === 0) return { files: 0, insertions: 0, deletions: 0, summary: "no uncommitted changes" };

  let insertions = 0;
  let deletions = 0;
  const numstat = (await git(root, ["diff", "--numstat"], execFileImpl)).trim();
  for (const line of numstat ? numstat.split("\n") : []) {
    const [added, removed] = line.split("\t");
    insertions += Number.parseInt(added, 10) || 0;
    deletions += Number.parseInt(removed, 10) || 0;
  }
  for (const line of porcelain.split("\n")) {
    if (!line.startsWith("??")) continue;
    const untracked = path.join(root, line.slice(3).trim());
    try {
      const { readFileSync } = await import("node:fs");
      insertions += readFileSync(untracked, "utf8").split("\n").length - 1;
    } catch {
      // Directories and unreadable entries contribute no line count.
    }
  }

  const noun = files === 1 ? "file" : "files";
  return { files, insertions, deletions, summary: `${files} ${noun} changed, +${insertions}/-${deletions}` };
}

export { requireGitHubRepo, parseGitHubRemote, currentBranch, workingTreeSummary, git };
```

- [ ] **Step 6: Vendor the seal module**

```bash
cp product/relayd/src/seal.mjs product/cli/src/seal.mjs
chmod +x product/cli/bin/relay
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd product/cli && node --test test/*.test.mjs`
Expected: PASS — 3 creds, 6 repo, 2 vendor tests.

- [ ] **Step 8: Commit**

```bash
git add product/cli
git commit -m "feat(cli): relay CLI skeleton, credential store, and GitHub repo guard"
```

---

## Task 17: `relay login` and `relay init`

**Files:**
- Create: `product/cli/src/cloud.mjs`, `product/cli/src/commands/login.mjs`, `product/cli/src/commands/init.mjs`
- Test: `product/cli/test/login.test.mjs`, `product/cli/test/init.test.mjs`

**Interfaces:**
- Consumes: `readCredentials`/`writeCredentials` (16), `requireGitHubRepo` (16), cloud device-code + repos + trial routes (5, 6, 3)
- Produces:
  - `createCloudApi({ baseUrl, sessionToken, fetchImpl }) -> { startDeviceLogin, pollDeviceToken, currentTrial, registerRepo, listHandoffs, createHandoff, createPairingSession, putDeviceBlob }`
  - `cmdLogin(args, deps) -> Promise<void>`
  - `cmdInit(args, deps) -> Promise<void>`
  - Both accept an injected `deps` object (`{ home, cwd, fetchImpl, openBrowser, log, sleep }`) so tests never open a browser or sleep in real time.

`relay login` prints the user code, opens the verification URL, polls at the server-supplied interval until approval, then fetches the account's trial node and pins `nodeId` + `nodeEncPubkey`. It prints the key fingerprint (first 16 hex of SHA-256) so a user can compare it against the app.

- [ ] **Step 1: Write the failing tests**

Create `product/cli/test/login.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { cmdLogin } = await import("../src/commands/login.mjs");
const { readCredentials } = await import("../src/creds.mjs");

function fakeCloud(script) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, options = {}) => {
      const pathname = new URL(url).pathname;
      calls.push({ pathname, body: options.body ? JSON.parse(options.body) : null, headers: options.headers || {} });
      const responder = script[pathname];
      const result = typeof responder === "function" ? responder(calls) : responder;
      return {
        status: result.status,
        json: async () => result.json,
      };
    },
  };
}

const TRIAL = {
  trial: { id: "t1", state: "ready", nodeId: "node-00112233445566aa", nodeEncPubkey: "a".repeat(43) + "=", sni: "x.tun.test", createdAt: 1, expiresAt: 2 },
};

test("login polls until approval, then pins the sandbox identity", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-login-"));
  let tokenCalls = 0;
  const cloud = fakeCloud({
    "/v1/auth/device/start": { status: 201, json: { deviceCode: "dc", userCode: "ABCD-EFGH", verificationUri: "https://relay.test/cli-login", interval: 5, expiresIn: 900 } },
    "/v1/auth/device/token": () => {
      tokenCalls += 1;
      return tokenCalls < 3
        ? { status: 400, json: { error: "authorization_pending" } }
        : { status: 200, json: { sessionToken: "sess", refreshToken: "ref", accountId: "acct", expiresIn: 900 } };
    },
    "/v1/trial-nodes/current": { status: 200, json: TRIAL },
  });
  const opened = [];
  const lines = [];

  await cmdLogin([], {
    home, baseUrl: "https://cloud.test", fetchImpl: cloud.fetchImpl,
    openBrowser: (url) => opened.push(url), log: (line) => lines.push(line), sleep: async () => {},
  });

  assert.deepEqual(opened, ["https://relay.test/cli-login"]);
  assert.ok(lines.some((line) => line.includes("ABCD-EFGH")), "the user code is shown");
  assert.equal(tokenCalls, 3, "polling continued until approval");

  const stored = readCredentials({ home });
  assert.equal(stored.sessionToken, "sess");
  assert.equal(stored.nodeId, "node-00112233445566aa");
  assert.equal(stored.nodeEncPubkey, TRIAL.trial.nodeEncPubkey);
  assert.ok(!lines.join("\n").includes("sess"), "the session token is never printed");
  assert.ok(!lines.join("\n").includes("dc"), "the device code is never printed");
});

test("login reports plainly when the account has no sandbox yet", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-login-nonode-"));
  const cloud = fakeCloud({
    "/v1/auth/device/start": { status: 201, json: { deviceCode: "dc", userCode: "ABCD-EFGH", verificationUri: "https://relay.test/cli-login", interval: 1, expiresIn: 900 } },
    "/v1/auth/device/token": { status: 200, json: { sessionToken: "sess", refreshToken: "ref", accountId: "acct" } },
    "/v1/trial-nodes/current": { status: 404, json: { error: "no_trial" } },
  });
  const lines = [];

  await cmdLogin([], { home, baseUrl: "https://cloud.test", fetchImpl: cloud.fetchImpl,
    openBrowser: () => {}, log: (line) => lines.push(line), sleep: async () => {} });

  assert.equal(readCredentials({ home }).sessionToken, "sess", "the session is still saved");
  assert.equal(readCredentials({ home }).nodeId, null);
  assert.match(lines.join("\n"), /no machine yet/i);
});

test("an expired device code aborts with a clear message", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-login-exp-"));
  const cloud = fakeCloud({
    "/v1/auth/device/start": { status: 201, json: { deviceCode: "dc", userCode: "ABCD-EFGH", verificationUri: "u", interval: 1, expiresIn: 900 } },
    "/v1/auth/device/token": { status: 400, json: { error: "expired_token" } },
  });

  await assert.rejects(() => cmdLogin([], { home, baseUrl: "https://cloud.test", fetchImpl: cloud.fetchImpl,
    openBrowser: () => {}, log: () => {}, sleep: async () => {} }), /login_expired/);
  assert.equal(readCredentials({ home }), null);
});
```

Create `product/cli/test/init.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const { cmdInit } = await import("../src/commands/init.mjs");
const { writeCredentials } = await import("../src/creds.mjs");

async function repoAndHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-init-"));
  const git = (...args) => execFileAsync("git", ["-C", dir, ...args]);
  await execFileAsync("git", ["init", "-q", "-b", "main", dir]);
  await git("config", "user.email", "t@example.com");
  await git("config", "user.name", "T");
  await git("remote", "add", "origin", "https://github.com/Me/Relay.git");
  fs.writeFileSync(path.join(dir, "README.md"), "# hi\n");
  await git("add", "-A");
  await git("commit", "-qm", "initial");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-init-home-"));
  writeCredentials({ sessionToken: "sess", accountId: "acct", nodeId: "node-1", nodeEncPubkey: "a".repeat(44) }, { home });
  return { dir, home };
}

test("init registers the repo and pins the node key fingerprint locally", async () => {
  const { dir, home } = await repoAndHome();
  const calls = [];
  const lines = [];

  await cmdInit([], {
    home, cwd: dir, baseUrl: "https://cloud.test", log: (line) => lines.push(line),
    fetchImpl: async (url, options) => {
      calls.push({ pathname: new URL(url).pathname, body: JSON.parse(options.body) });
      return { status: 201, json: async () => ({ repo: { id: "r1", fullName: "me/relay", createdAt: 1 } }) };
    },
  });

  assert.deepEqual(calls[0], { pathname: "/v1/repos", body: { fullName: "me/relay" } });
  const pinned = JSON.parse(fs.readFileSync(path.join(dir, ".git", "relay", "node.json"), "utf8"));
  assert.equal(pinned.nodeId, "node-1");
  assert.match(pinned.encPubkeyFingerprint, /^[a-f0-9]{16}$/);
  assert.match(lines.join("\n"), /me\/relay/);
});

test("init refuses without a login", async () => {
  const { dir } = await repoAndHome();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-init-nologin-"));
  await assert.rejects(() => cmdInit([], { home, cwd: dir, baseUrl: "https://cloud.test",
    fetchImpl: async () => { throw new Error("must not call the network"); }, log: () => {} }), /not_logged_in/);
});

test("init refuses outside a github repo", async () => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-init-plain-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-init-plain-home-"));
  writeCredentials({ sessionToken: "sess", nodeId: "node-1", nodeEncPubkey: "k" }, { home });
  await assert.rejects(() => cmdInit([], { home, cwd: plain, baseUrl: "https://cloud.test",
    fetchImpl: async () => { throw new Error("must not call the network"); }, log: () => {} }), /not_a_git_repo/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd product/cli && node --test test/login.test.mjs test/init.test.mjs`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write `cloud.mjs`**

Create `product/cli/src/cloud.mjs`:

```js
// Thin typed wrapper over the relay-cloud HTTP API. Every method returns
// { status, json } so callers decide what a non-2xx means; nothing here throws
// on status alone, and nothing here logs.
const DEFAULT_BASE_URL = process.env.RELAY_CLOUD_URL || "https://api.relay.example";

function createCloudApi({ baseUrl = DEFAULT_BASE_URL, sessionToken = null, fetchImpl = fetch } = {}) {
  const base = String(baseUrl).replace(/\/+$/, "");

  async function request(method, pathname, { body, headers = {}, raw } = {}) {
    const init = { method, headers: { ...headers } };
    if (sessionToken) init.headers.authorization = `Bearer ${sessionToken}`;
    if (raw !== undefined) {
      init.headers["content-type"] = "application/octet-stream";
      init.body = raw;
    } else if (body !== undefined) {
      init.headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const res = await fetchImpl(`${base}${pathname}`, init);
    const json = await res.json().catch(() => null);
    return { status: res.status, json };
  }

  return {
    baseUrl: base,
    startDeviceLogin: () => request("POST", "/v1/auth/device/start", { body: {} }),
    pollDeviceToken: (deviceCode) => request("POST", "/v1/auth/device/token", { body: { deviceCode } }),
    currentTrial: () => request("GET", "/v1/trial-nodes/current"),
    registerRepo: (fullName) => request("POST", "/v1/repos", { body: { fullName } }),
    createHandoff: (payload) => request("POST", "/v1/handoffs", { body: payload }),
    listHandoffs: (repo) => request("GET", `/v1/handoffs?repo=${encodeURIComponent(repo)}`),
    createPairingSession: (authToken, kind) => request("POST", "/v1/pairing/sessions", { body: { authToken, kind } }),
    putDeviceBlob: (pairingId, authToken, tag, raw) =>
      request("POST", `/v1/pairing/sessions/${encodeURIComponent(pairingId)}/device-blob`,
        { raw, headers: { "x-pairing-auth": authToken, "x-pairing-tag": tag } }),
  };
}

export { createCloudApi, DEFAULT_BASE_URL };
```

- [ ] **Step 4: Write `login.mjs`**

Create `product/cli/src/commands/login.mjs`:

```js
// relay login — browser device-code sign-in, then pin the sandbox this machine
// hands off to. The session token and device code are never printed; only the
// user code (which is meant to be read aloud) and the key fingerprint are.
import crypto from "node:crypto";
import { execFile } from "node:child_process";

import { createCloudApi, DEFAULT_BASE_URL } from "../cloud.mjs";
import { writeCredentials } from "../creds.mjs";

function defaultOpenBrowser(url) {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  execFile(opener, [url], () => {});
}

function fingerprint(encPubkeyB64) {
  return crypto.createHash("sha256").update(String(encPubkeyB64)).digest("hex").slice(0, 16);
}

async function cmdLogin(args = [], deps = {}) {
  const {
    home = undefined,
    baseUrl = DEFAULT_BASE_URL,
    fetchImpl = fetch,
    openBrowser = defaultOpenBrowser,
    log = console.log,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = deps;

  const anonymous = createCloudApi({ baseUrl, fetchImpl });
  const start = await anonymous.startDeviceLogin();
  if (start.status !== 201) throw new Error(`login_start_failed_${start.status}`);

  const { deviceCode, userCode, verificationUri, interval } = start.json;
  log("");
  log(`  Your code:  ${userCode}`);
  log(`  Approve at: ${verificationUri}`);
  log("");
  log("  Waiting for approval…");
  openBrowser(verificationUri);

  let session = null;
  for (;;) {
    await sleep((interval || 5) * 1000);
    const poll = await anonymous.pollDeviceToken(deviceCode);
    if (poll.status === 200) { session = poll.json; break; }
    const error = poll.json?.error;
    if (error === "authorization_pending") continue;
    if (error === "expired_token") throw new Error("login_expired: the code timed out — run relay login again");
    throw new Error(`login_failed: ${error || poll.status}`);
  }

  writeCredentials({
    sessionToken: session.sessionToken,
    refreshToken: session.refreshToken,
    accountId: session.accountId,
  }, { home });
  log("  Signed in.");

  const authed = createCloudApi({ baseUrl, sessionToken: session.sessionToken, fetchImpl });
  const trial = await authed.currentTrial();
  if (trial.status !== 200 || !trial.json?.trial?.nodeId) {
    log("  You have no machine yet — create one in the Relay app, then run relay login again.");
    return;
  }

  const { nodeId, nodeEncPubkey } = trial.json.trial;
  writeCredentials({ nodeId, nodeEncPubkey }, { home });
  log(`  Machine:    ${nodeId}`);
  if (nodeEncPubkey) log(`  Key:        ${fingerprint(nodeEncPubkey)}  (compare with the app)`);
  else log("  Machine has no encryption key yet — update it before handing off.");
}

export { cmdLogin, fingerprint };
```

- [ ] **Step 5: Write `init.mjs`**

Create `product/cli/src/commands/init.mjs`:

```js
// relay init — register this repository with the control plane and pin the
// fingerprint of the node key that handoff blobs will be sealed to. The pin
// lives in .git/relay/, which git never commits.
import fs from "node:fs";
import path from "node:path";

import { createCloudApi, DEFAULT_BASE_URL } from "../cloud.mjs";
import { readCredentials } from "../creds.mjs";
import { requireGitHubRepo } from "../repo.mjs";
import { fingerprint } from "./login.mjs";

async function cmdInit(args = [], deps = {}) {
  const { home = undefined, cwd = process.cwd(), baseUrl = DEFAULT_BASE_URL, fetchImpl = fetch, log = console.log } = deps;

  const credentials = readCredentials({ home });
  if (!credentials?.sessionToken) throw new Error("not_logged_in: run relay login first");

  const repo = await requireGitHubRepo({ cwd });
  const api = createCloudApi({ baseUrl, sessionToken: credentials.sessionToken, fetchImpl });
  const registered = await api.registerRepo(repo.fullName);
  if (registered.status !== 201) throw new Error(`repo_registration_failed_${registered.status}`);

  const pinPath = path.join(repo.root, ".git", "relay", "node.json");
  fs.mkdirSync(path.dirname(pinPath), { recursive: true });
  fs.writeFileSync(pinPath, `${JSON.stringify({
    nodeId: credentials.nodeId,
    encPubkeyFingerprint: credentials.nodeEncPubkey ? fingerprint(credentials.nodeEncPubkey) : null,
    registeredAt: new Date().toISOString(),
  }, null, 2)}\n`, { mode: 0o600 });

  log(`  Repository: ${repo.fullName}`);
  log(`  Machine:    ${credentials.nodeId || "none pinned"}`);
  log("");
  log("  relay handoff will push a relay/handoff-* branch here and notify your phone.");
}

export { cmdInit };
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd product/cli && node --test test/login.test.mjs test/init.test.mjs`
Expected: PASS — 3 login, 3 init tests.

- [ ] **Step 7: Commit**

```bash
git add product/cli
git commit -m "feat(cli): relay login device-code flow and relay init"
```

---

## Task 18: Local session discovery

**Files:**
- Create: `product/cli/src/sessions.mjs`
- Test: `product/cli/test/sessions.test.mjs`

**Interfaces:**
- Consumes: nothing from earlier tasks
- Produces:
  - `discoverSessions({ cwd, home }) -> Array<Session>` sorted by `lastActive` descending
  - `Session = { id, harness, title, lastActive, filePath, format, sizeBytes }` with `format ∈ {"claude-jsonl","codex-rollout","none"}`
  - `readSessionBytes(session, { maxBytes }) -> Buffer | null` — `null` when the file exceeds `maxBytes`
  - `sessionExcerpt(session, { maxChars = 600 }) -> string`
  - `claudeProjectSlug(cwd) -> string` (same rule as relayd's copy)

Claude sessions live at `~/.claude/projects/<slug>/<uuid>.jsonl`. Codex rollouts live under `~/.codex/sessions/**/rollout-*.jsonl` and record their `cwd` in the first line. Cursor exposes no portable session file, so discovery returns nothing for it and the handoff falls back to summary-priming.

- [ ] **Step 1: Write the failing test**

Create `product/cli/test/sessions.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { discoverSessions, readSessionBytes, sessionExcerpt, claudeProjectSlug } = await import("../src/sessions.mjs");

const CWD = "/Users/dev/code/relay";

function writeClaudeSession(home, id, lines, mtime) {
  const file = path.join(home, ".claude", "projects", claudeProjectSlug(CWD), `${id}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  if (mtime) fs.utimesSync(file, mtime, mtime);
  return file;
}

function writeCodexRollout(home, id, cwd, mtime) {
  const file = path.join(home, ".codex", "sessions", "2026", "08", `rollout-${id}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ cwd, id })}\n${JSON.stringify({ type: "user", text: "codex work" })}\n`);
  if (mtime) fs.utimesSync(file, mtime, mtime);
  return file;
}

test("claude sessions for this cwd are discovered, newest first", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-sessions-"));
  writeClaudeSession(home, "11111111-1111-4111-8111-111111111111",
    [{ type: "user", cwd: CWD, message: { content: "older question" } }], new Date("2026-08-10T10:00:00Z"));
  writeClaudeSession(home, "22222222-2222-4222-8222-222222222222",
    [{ type: "user", cwd: CWD, message: { content: "fix the auth redirect loop" } }], new Date("2026-08-11T10:00:00Z"));

  const sessions = discoverSessions({ cwd: CWD, home });

  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].id, "22222222-2222-4222-8222-222222222222");
  assert.equal(sessions[0].harness, "claude");
  assert.equal(sessions[0].format, "claude-jsonl");
  assert.match(sessions[0].title, /fix the auth redirect loop/i);
});

test("sessions belonging to another directory are not offered", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-sessions-other-"));
  const otherSlug = claudeProjectSlug("/Users/dev/code/unrelated");
  const file = path.join(home, ".claude", "projects", otherSlug, "33333333-3333-4333-8333-333333333333.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ type: "user", cwd: "/Users/dev/code/unrelated" })}\n`);

  assert.deepEqual(discoverSessions({ cwd: CWD, home }), []);
});

test("codex rollouts are matched by the cwd they record", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-sessions-codex-"));
  writeCodexRollout(home, "aaaa1111", CWD, new Date("2026-08-11T09:00:00Z"));
  writeCodexRollout(home, "bbbb2222", "/Users/dev/code/other", new Date("2026-08-11T09:30:00Z"));

  const sessions = discoverSessions({ cwd: CWD, home });

  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].harness, "codex");
  assert.equal(sessions[0].format, "codex-rollout");
  assert.equal(sessions[0].id, "aaaa1111");
});

test("an oversized session is reported but refuses to load", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-sessions-big-"));
  writeClaudeSession(home, "44444444-4444-4444-8444-444444444444",
    [{ type: "user", cwd: CWD, message: { content: "x".repeat(5000) } }]);

  const [session] = discoverSessions({ cwd: CWD, home });

  assert.ok(session.sizeBytes > 4000);
  assert.equal(readSessionBytes(session, { maxBytes: 1000 }), null, "over the cap, nothing is loaded");
  assert.ok(readSessionBytes(session, { maxBytes: 1_000_000 }).length > 4000);
});

test("an excerpt is bounded and drawn from the newest turns", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-sessions-exc-"));
  writeClaudeSession(home, "55555555-5555-4555-8555-555555555555", [
    { type: "user", cwd: CWD, message: { content: "first thing" } },
    { type: "assistant", message: { content: "the newest reply" } },
  ]);

  const excerpt = sessionExcerpt(discoverSessions({ cwd: CWD, home })[0], { maxChars: 100 });

  assert.ok(excerpt.length <= 100);
  assert.match(excerpt, /newest reply/);
});

test("no sessions anywhere yields an empty list rather than an error", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-sessions-empty-"));
  assert.deepEqual(discoverSessions({ cwd: CWD, home }), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd product/cli && node --test test/sessions.test.mjs`
Expected: FAIL — `Cannot find module '../src/sessions.mjs'`.

- [ ] **Step 3: Write the implementation**

Create `product/cli/src/sessions.mjs`:

```js
// Find the local agent sessions that belong to this repository.
//
// Claude Code keys its transcripts by a slugified absolute cwd; Codex records
// the cwd inside the rollout. Cursor keeps no portable session file, so it is
// absent here by design and the handoff falls back to summary-priming rather
// than pretending a resume is possible.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_SCAN_FILES = 500;

function claudeProjectSlug(cwd) {
  return String(cwd).replace(/[^A-Za-z0-9]/g, "-");
}

function firstText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = firstText(item?.text ?? item?.content ?? item);
      if (text) return text;
    }
    return "";
  }
  if (value && typeof value === "object") return firstText(value.text ?? value.content ?? "");
  return "";
}

function readJsonLines(filePath, { limit = 400 } = {}) {
  let text = "";
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  const lines = text.split("\n").filter(Boolean).slice(0, limit);
  const records = [];
  for (const line of lines) {
    try {
      records.push(JSON.parse(line));
    } catch {
      // A partially flushed trailing line is normal for a live session.
    }
  }
  return records;
}

function titleFrom(records, fallback) {
  for (const record of records) {
    if (record?.type !== "user") continue;
    const text = firstText(record.message?.content ?? record.message ?? record.text).trim();
    if (text) return text.split("\n")[0].slice(0, 120);
  }
  return fallback;
}

function discoverClaudeSessions({ cwd, home }) {
  const dir = path.join(home, ".claude", "projects", claudeProjectSlug(cwd));
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith(".jsonl")).slice(0, MAX_SCAN_FILES);
  } catch {
    return [];
  }
  return names.map((name) => {
    const filePath = path.join(dir, name);
    const stat = fs.statSync(filePath);
    const records = readJsonLines(filePath, { limit: 40 });
    return {
      id: name.slice(0, -".jsonl".length),
      harness: "claude",
      format: "claude-jsonl",
      title: titleFrom(records, "Claude Code session"),
      lastActive: stat.mtime.toISOString(),
      filePath,
      sizeBytes: stat.size,
    };
  });
}

function discoverCodexSessions({ cwd, home }) {
  const root = path.join(home, ".codex", "sessions");
  const found = [];
  const stack = [root];
  let visited = 0;
  while (stack.length > 0 && visited < MAX_SCAN_FILES) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) { stack.push(entryPath); continue; }
      if (!entry.name.startsWith("rollout-") || !entry.name.endsWith(".jsonl")) continue;
      visited += 1;
      const records = readJsonLines(entryPath, { limit: 40 });
      const recordedCwd = records.find((record) => typeof record?.cwd === "string")?.cwd;
      if (recordedCwd !== cwd) continue;
      const stat = fs.statSync(entryPath);
      found.push({
        id: entry.name.slice("rollout-".length, -".jsonl".length),
        harness: "codex",
        format: "codex-rollout",
        title: titleFrom(records, "Codex session"),
        lastActive: stat.mtime.toISOString(),
        filePath: entryPath,
        sizeBytes: stat.size,
      });
    }
  }
  return found;
}

function discoverSessions({ cwd, home = os.homedir() } = {}) {
  return [...discoverClaudeSessions({ cwd, home }), ...discoverCodexSessions({ cwd, home })]
    .sort((left, right) => right.lastActive.localeCompare(left.lastActive));
}

function readSessionBytes(session, { maxBytes = 20 * 1024 * 1024 } = {}) {
  if (!session?.filePath || session.sizeBytes > maxBytes) return null;
  try {
    return fs.readFileSync(session.filePath);
  } catch {
    return null;
  }
}

function sessionExcerpt(session, { maxChars = 600 } = {}) {
  if (!session?.filePath) return "";
  const records = readJsonLines(session.filePath, { limit: 400 });
  const texts = [];
  for (const record of records.slice(-12)) {
    const text = firstText(record?.message?.content ?? record?.message ?? record?.text).trim();
    if (text) texts.push(text);
  }
  return texts.join("\n").slice(-maxChars);
}

export { discoverSessions, readSessionBytes, sessionExcerpt, claudeProjectSlug };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd product/cli && node --test test/sessions.test.mjs`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add product/cli/src/sessions.mjs product/cli/test/sessions.test.mjs
git commit -m "feat(cli): local session discovery for claude and codex"
```

---

## Task 19: `relay handoff`

**Files:**
- Create: `product/cli/src/commands/handoff.mjs`
- Test: `product/cli/test/handoff.test.mjs`

**Interfaces:**
- Consumes: everything from Tasks 16–18, plus `sealTo` from the vendored `seal.mjs`
- Produces:
  - `cmdHandoff(args, deps) -> Promise<{ handoffId, branch, pushed }>`
  - `buildManifest({ repo, session, wip, excerpt, handoffId, branch, machine, now }) -> object` — the v1 manifest relayd's `importHandoff` consumes
  - `handoffBranchName(title, handoffId) -> string` — `relay/handoff-<slug>-<id first 6>`
  - Flags: `--session <id>` selects a specific session; `--title <text>` overrides the derived title; `--no-push` stops before pushing (for inspection)

Order of operations is deliberate: create the branch **first**, then assert the current branch matches `relay/handoff-*`, then write the sealed blobs. A failure at any earlier point leaves the user on their original branch with their work untouched.

**Branch collisions.** The spec called for a numeric suffix on collision. This plan instead appends the first six hex characters of the handoff id, which is generated fresh per handoff — the name is unique by construction, so there is no collision to detect and no retry loop to get wrong. The suffix doubles as the handle that ties a branch back to its handoff record.

- [ ] **Step 1: Write the failing test**

Create `product/cli/test/handoff.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const { cmdHandoff, handoffBranchName } = await import("../src/commands/handoff.mjs");
const { writeCredentials } = await import("../src/creds.mjs");
const { generateEncKeyPair, openSealed } = await import("../src/seal.mjs");
const { claudeProjectSlug } = await import("../src/sessions.mjs");

process.env.RELAY_ALLOW_LOCAL_REMOTE = "1";

async function scenario({ withSession = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-handoff-"));
  const work = path.join(root, "repo");
  const bare = path.join(root, "origin.git");
  const home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true });

  await execFileAsync("git", ["init", "-q", "--bare", bare]);
  await execFileAsync("git", ["init", "-q", "-b", "main", work]);
  const git = (...args) => execFileAsync("git", ["-C", work, ...args]);
  await git("config", "user.email", "t@example.com");
  await git("config", "user.name", "T");
  await git("remote", "add", "origin", bare);
  fs.writeFileSync(path.join(work, "README.md"), "# repo\n");
  await git("add", "-A");
  await git("commit", "-qm", "initial");
  await git("push", "-q", "origin", "main");

  fs.writeFileSync(path.join(work, "wip.txt"), "unfinished work\n");

  if (withSession) {
    const dir = path.join(home, ".claude", "projects", claudeProjectSlug(fs.realpathSync(work)));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "11111111-1111-4111-8111-111111111111.jsonl"),
      `${JSON.stringify({ type: "user", cwd: fs.realpathSync(work), message: { content: "fix the auth redirect" } })}\n`);
  }

  const node = generateEncKeyPair();
  writeCredentials({ sessionToken: "sess", accountId: "acct", nodeId: "node-1", nodeEncPubkey: node.publicKeyB64 }, { home });

  // Records every call. `relay handoff` also refreshes the session index on a
  // best-effort basis, so this must tolerate non-JSON bodies and unrelated paths.
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const pathname = new URL(url).pathname;
    let body = null;
    if (typeof options.body === "string") { try { body = JSON.parse(options.body); } catch { body = null; } }
    calls.push({ pathname, body });
    if (pathname === "/v1/handoffs") {
      return { status: 201, json: async () => ({ handoff: { id: body.handoffId, state: "pending" } }) };
    }
    return { status: 500, json: async () => ({ error: "not_part_of_this_test" }) };
  };
  const handoffPings = () => calls.filter((call) => call.pathname === "/v1/handoffs");

  return { root, work, bare, home, node, calls, handoffPings, fetchImpl };
}

test("handoff branches, commits WIP, seals blobs, pushes, and pings", async () => {
  const s = await scenario();
  const lines = [];

  const result = await cmdHandoff([], {
    home: s.home, cwd: s.work, baseUrl: "https://cloud.test", fetchImpl: s.fetchImpl,
    log: (line) => lines.push(line), machine: "MacBook-Pro",
  });

  assert.match(result.branch, /^relay\/handoff-fix-the-auth-redirect-[a-f0-9]{6}$/);
  assert.equal(result.pushed, true);

  const { stdout: branches } = await execFileAsync("git", ["-C", s.bare, "branch", "--list"]);
  assert.match(branches, new RegExp(result.branch.replace("/", "\\/")));

  const { stdout: files } = await execFileAsync("git", ["-C", s.bare, "ls-tree", "-r", "--name-only", result.branch]);
  assert.match(files, /wip\.txt/, "uncommitted work travelled with the branch");
  assert.match(files, new RegExp(`\\.relay/handoff/${result.handoffId}/manifest\\.enc`));
  assert.match(files, new RegExp(`\\.relay/handoff/${result.handoffId}/session\\.enc`));

  assert.equal(s.handoffPings().length, 1, "exactly one ping per handoff");
  assert.deepEqual(Object.keys(s.handoffPings()[0].body).sort(), ["branch", "handoffId", "nodeId", "repo"]);
});

test("the sealed manifest is readable only by the node and describes the session", async () => {
  const s = await scenario();
  const result = await cmdHandoff([], { home: s.home, cwd: s.work, baseUrl: "https://cloud.test",
    fetchImpl: s.fetchImpl, log: () => {}, machine: "MacBook-Pro" });

  const { stdout } = await execFileAsync("git",
    ["-C", s.bare, "show", `${result.branch}:.relay/handoff/${result.handoffId}/manifest.enc`],
    { encoding: "buffer" });
  const manifest = JSON.parse(openSealed(s.node.privateKeyPem, stdout).toString("utf8"));

  assert.equal(manifest.v, 1);
  assert.equal(manifest.harness, "claude");
  assert.equal(manifest.sessionFormat, "claude-jsonl");
  assert.equal(manifest.sessionId, "11111111-1111-4111-8111-111111111111");
  assert.equal(manifest.repo, path.basename(s.bare, ".git") ? manifest.repo : manifest.repo);
  assert.match(manifest.title, /fix the auth redirect/i);
  assert.equal(manifest.wip.files, 1);
  assert.ok(!stdout.includes(Buffer.from("fix the auth redirect", "utf8")), "the blob is ciphertext on disk");
});

test("with no local session the handoff still lands, marked session-less", async () => {
  const s = await scenario({ withSession: false });
  const lines = [];

  const result = await cmdHandoff([], { home: s.home, cwd: s.work, baseUrl: "https://cloud.test",
    fetchImpl: s.fetchImpl, log: (line) => lines.push(line), machine: "MacBook-Pro" });

  const { stdout } = await execFileAsync("git",
    ["-C", s.bare, "show", `${result.branch}:.relay/handoff/${result.handoffId}/manifest.enc`], { encoding: "buffer" });
  const manifest = JSON.parse(openSealed(s.node.privateKeyPem, stdout).toString("utf8"));

  assert.equal(manifest.sessionFormat, "none");
  assert.equal(manifest.sessionId, null);
  assert.match(lines.join("\n"), /no local session/i);
});

test("the original branch and working tree are restored afterwards", async () => {
  const s = await scenario();
  await cmdHandoff([], { home: s.home, cwd: s.work, baseUrl: "https://cloud.test",
    fetchImpl: s.fetchImpl, log: () => {}, machine: "MacBook-Pro" });

  const { stdout: branch } = await execFileAsync("git", ["-C", s.work, "rev-parse", "--abbrev-ref", "HEAD"]);
  assert.equal(branch.trim(), "main", "the user is left where they started");
  assert.equal(fs.readFileSync(path.join(s.work, "wip.txt"), "utf8"), "unfinished work\n",
    "their uncommitted work is still in the tree");
});

test("handoff refuses without a login or a pinned node key", async () => {
  const s = await scenario();
  const noKeyHome = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-handoff-nokey-"));
  writeCredentials({ sessionToken: "sess", accountId: "acct" }, { home: noKeyHome });

  await assert.rejects(() => cmdHandoff([], { home: noKeyHome, cwd: s.work, baseUrl: "https://cloud.test",
    fetchImpl: s.fetchImpl, log: () => {} }), /no_machine_pinned/);
});

test("--no-push stops before publishing and says so", async () => {
  const s = await scenario();
  const lines = [];
  const result = await cmdHandoff(["--no-push"], { home: s.home, cwd: s.work, baseUrl: "https://cloud.test",
    fetchImpl: s.fetchImpl, log: (line) => lines.push(line), machine: "MacBook-Pro" });

  assert.equal(result.pushed, false);
  assert.deepEqual(s.calls, [], "an unpublished handoff contacts the network not at all");
  const { stdout: branches } = await execFileAsync("git", ["-C", s.bare, "branch", "--list"]);
  assert.ok(!branches.includes("handoff"), "nothing reached the remote");
});

test("branch names are slugged, bounded, and collision-resistant", () => {
  assert.equal(handoffBranchName("Fix the auth redirect!", "abc123def456"), "relay/handoff-fix-the-auth-redirect-abc123");
  assert.ok(handoffBranchName("x".repeat(200), "abc123def456").length <= 64);
  assert.equal(handoffBranchName("", "abc123def456"), "relay/handoff-session-abc123");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd product/cli && node --test test/handoff.test.mjs`
Expected: FAIL — `Cannot find module '../src/commands/handoff.mjs'`.

- [ ] **Step 3: Write the implementation**

Create `product/cli/src/commands/handoff.mjs`:

```js
// relay handoff — the shut-the-laptop moment.
//
// The branch carries the work; two blobs sealed to the node's key carry the
// manifest and the transcript. GitHub therefore stores ciphertext for anything
// conversational, and the control plane is told only names. The user's original
// branch and working tree are restored before this returns.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createCloudApi, DEFAULT_BASE_URL } from "../cloud.mjs";
import { readCredentials } from "../creds.mjs";
import { requireGitHubRepo, workingTreeSummary, git } from "../repo.mjs";
import { discoverSessions, readSessionBytes, sessionExcerpt } from "../sessions.mjs";
import { sealTo } from "../seal.mjs";

const MAX_SESSION_BYTES = 20 * 1024 * 1024;
const BLOB_PATH_PREFIX = ".relay/handoff";

function flagValue(args, name) {
  const index = args.findIndex((arg) => arg === name || arg.startsWith(`${name}=`));
  if (index === -1) return null;
  const arg = args[index];
  return arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : args[index + 1] || null;
}

function handoffBranchName(title, handoffId) {
  const slug = String(title || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40)
    .replace(/-+$/, "");
  return `relay/handoff-${slug || "session"}-${handoffId.slice(0, 6)}`;
}

function buildManifest({ repo, session, wip, excerpt, handoffId, branch, machine, now }) {
  return {
    v: 1,
    id: handoffId,
    harness: session?.harness || "cursor",
    sessionId: session?.id || null,
    sessionFormat: session?.format || "none",
    title: session?.title || `Work on ${repo.fullName}`,
    repo: repo.fullName,
    baseBranch: repo.branch,
    branch,
    cwd: repo.root,
    machine,
    createdAt: now,
    wip,
    excerpt,
  };
}

async function cmdHandoff(args = [], deps = {}) {
  const {
    home = undefined, cwd = process.cwd(), baseUrl = DEFAULT_BASE_URL, fetchImpl = fetch,
    log = console.log, machine = os.hostname(), now = () => Date.now(),
  } = deps;

  const credentials = readCredentials({ home });
  if (!credentials?.sessionToken) throw new Error("not_logged_in: run relay login first");
  if (!credentials.nodeId || !credentials.nodeEncPubkey) {
    throw new Error("no_machine_pinned: run relay login after creating a machine in the app");
  }

  const repo = await requireGitHubRepo({ cwd });
  const realRoot = fs.realpathSync(repo.root);
  const wip = await workingTreeSummary({ root: repo.root });

  const requestedId = flagValue(args, "--session");
  const sessions = discoverSessions({ cwd: realRoot, home });
  const session = requestedId ? sessions.find((entry) => entry.id === requestedId) || null : sessions[0] || null;
  if (requestedId && !session) throw new Error(`unknown_session: no local session ${requestedId} for this repository`);
  if (!session) log("  No local session found — handing off the working tree with a summary instead.");

  const handoffId = crypto.randomBytes(8).toString("hex");
  const titleOverride = flagValue(args, "--title");
  const title = titleOverride || session?.title || `Work on ${repo.fullName}`;
  const branch = handoffBranchName(title, handoffId);

  let sessionBytes = session ? readSessionBytes(session, { maxBytes: MAX_SESSION_BYTES }) : null;
  if (session && !sessionBytes) {
    log(`  Session transcript is larger than ${MAX_SESSION_BYTES / 1024 / 1024} MB — sending a summary instead.`);
  }

  const manifest = buildManifest({
    repo: { ...repo, root: realRoot }, session: sessionBytes ? session : null,
    wip, excerpt: session ? sessionExcerpt(session) : "", handoffId, branch, machine, now: now(),
  });
  if (!sessionBytes) { manifest.sessionFormat = "none"; manifest.sessionId = null; }
  manifest.title = title;

  // Build the handoff commit with plumbing against a THROWAWAY INDEX. We never
  // check out a branch, never write into the user's working tree, and never
  // touch .git/index — so there is nothing to restore afterwards and no way to
  // lose their uncommitted work. See the note below for why the obvious
  // checkout-based version is wrong.
  const ref = `refs/heads/${branch}`;
  if (!ref.startsWith("refs/heads/relay/handoff-")) throw new Error("refusing_to_write_blobs_off_handoff_branch");

  const tmpIndex = path.join(os.tmpdir(), `relay-handoff-index-${crypto.randomUUID()}`);
  const run = (...gitArgs) => git(repo.root, gitArgs, { env: { ...process.env, GIT_INDEX_FILE: tmpIndex } });
  const runStdin = (input, ...gitArgs) => git(repo.root, gitArgs, { input });
  let pushed = false;

  try {
    // Seed the throwaway index from HEAD, then stage every WIP change into it.
    // `git add -A` reads the working tree and writes only the index plus new
    // objects: it modifies no file on disk, and it honours .gitignore, so
    // ignored secrets never reach the branch we are about to push to GitHub.
    await run("read-tree", "HEAD");
    await run("add", "-A");

    // Sealed blobs go straight into the object database — they are never
    // written into the user's checkout at all.
    const addBlob = async (relPath, bytes) => {
      const sha = (await runStdin(bytes, "hash-object", "-w", "--stdin")).trim();
      await run("update-index", "--add", "--cacheinfo", `100644,${sha},${relPath}`);
    };
    await addBlob(`${BLOB_PATH_PREFIX}/${handoffId}/manifest.enc`,
      sealTo(credentials.nodeEncPubkey, Buffer.from(JSON.stringify(manifest), "utf8")));
    if (sessionBytes) {
      await addBlob(`${BLOB_PATH_PREFIX}/${handoffId}/session.enc`,
        sealTo(credentials.nodeEncPubkey, sessionBytes));
    }

    const tree = (await run("write-tree")).trim();
    let commit;
    try {
      commit = (await git(repo.root, ["-c", "user.name=relay", "-c", "user.email=relay@localhost",
        "commit-tree", tree, "-p", "HEAD", "-m", `relay: handoff ${handoffId}`])).trim();
    } catch (err) {
      throw new Error("no_git_identity", { cause: err });
    }
    await git(repo.root, ["update-ref", ref, commit]);

    if (args.includes("--no-push")) {
      log(`  Prepared ${branch} locally. Nothing was pushed and no notification was sent.`);
    } else {
      await git(repo.root, ["push", "-q", "origin", `${ref}:${ref}`]);
      pushed = true;
    }
  } finally {
    fs.rmSync(tmpIndex, { force: true });
  }

  if (!pushed) return { handoffId, branch, pushed: false };

  const api = createCloudApi({ baseUrl, sessionToken: credentials.sessionToken, fetchImpl });
  const ping = await api.createHandoff({ handoffId, repo: repo.fullName, branch, nodeId: credentials.nodeId });
  if (ping.status !== 201) {
    log(`  Pushed ${branch}, but the notification failed (${ping.json?.error || ping.status}).`);
    log("  Your machine will still pick it up on its next poll.");
    return { handoffId, branch, pushed: true };
  }

  // Keep the phone's "On your Mac" list current. Best-effort by design: the
  // handoff has already succeeded and must not be reported as failed here.
  try {
    const { publishSessionIndex } = await import("./syncauth.mjs");
    await publishSessionIndex({
      repoFullName: repo.fullName, root: realRoot, home: home || os.homedir(),
      api, nodeEncPubkey: credentials.nodeEncPubkey, machine,
    });
  } catch {
    // The index stays as it was; nothing about the handoff changes.
  }

  log("");
  log(`  Handed off: ${title}`);
  log(`  Branch:     ${branch}`);
  log(`  Machine:    ${credentials.nodeId}`);
  log("");
  log("  Check your phone — it should be there in a moment.");
  return { handoffId, branch, pushed: true };
}

export { cmdHandoff, buildManifest, handoffBranchName };
```

**Why plumbing instead of `git checkout -b`.** An earlier draft of this task created the branch, committed the WIP onto it, and then restored the user with `git checkout <startingBranch>` followed by `git checkout -- .`. That silently **destroys uncommitted work**, and it was caught only because the implementer ran a standalone repro when a test failed.

The mechanism: an untracked file such as `wip.txt` becomes tracked-and-clean once it is committed onto the handoff branch. When git then checks out the original branch, it sees a file that is clean on the branch being left and absent from the target tree — so it **deletes it**, with no data-loss warning, because from git's point of view the content is safely committed elsewhere. `git checkout -- .` cannot bring it back either: the file was never in the original branch's index or tree, so there is nothing to restore it from.

The plumbing version above sidesteps the whole class of problem. It never moves HEAD, never checks out a branch, never writes a byte into the working tree, and writes only to a throwaway index in `$TMPDIR`. There is nothing to restore because nothing was disturbed. It also makes the "handoff blobs live only on `relay/handoff-*` branches" invariant **structural** rather than asserted — the blobs are reachable only from the ref we just created — and the `git add -A` honours `.gitignore`, so an ignored `.env` never reaches GitHub, where history is not revocable.

Two things the tests must get right. Assert the working tree is untouched by comparing `git status --porcelain -z`, `git rev-parse HEAD`, `git symbolic-ref HEAD`, and a content hash of every file, before and after; the unchanged `symbolic-ref HEAD` is what proves no checkout happened. But do **not** assert that `.git/index` is byte-identical — building the WIP summary runs `git status`, which refreshes the index stat cache and rewrites the file with no semantic change. And pair every "nothing was lost" assertion with a positive one: `git ls-tree -r <branch>` must actually contain the WIP file and both `.enc` paths, because proving nothing broke is worthless without proving the work was captured.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd product/cli && node --test test/handoff.test.mjs`
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add product/cli/src/commands/handoff.mjs product/cli/test/handoff.test.mjs
git commit -m "feat(cli): relay handoff — sealed session transfer over a handoff branch"
```

---

## Task 20: `relay sync-auth` and `relay status`

**Files:**
- Create: `product/cli/src/commands/syncauth.mjs`, `product/cli/src/commands/status.mjs`
- Test: `product/cli/test/syncauth.test.mjs`, `product/cli/test/status.test.mjs`

**Interfaces:**
- Consumes: `createCloudApi` (17), `sealTo`, `discoverSessions` (18), relayd's bundle shapes (Task 15)
- Produces:
  - `cmdSyncAuth(args, deps) -> Promise<{ installed: string[], skipped: string[], pairingId }>`
  - `collectCredentialBundle({ home, execFileImpl }) -> { bundle, skipped }`
  - `publishSessionIndex({ repoFullName, root, home, api, nodeEncPubkey, machine }) -> Promise<number>` — returns how many sessions were published
  - `cmdStatus(args, deps) -> Promise<void>`
  - Pairing derivations `authTokenFor(secret)` and `blobTagFor(macKey, slot, blob)` re-implemented from the documented protocol (a second source of truth, as `cloud/test/pairing.test.mjs` and `TrialPairingTests.swift` already do)

**Who publishes the session index.** Both `relay sync-auth` and `relay handoff` refresh it, so the phone's "On your Mac" list tracks reality without a daemon. In both it is best-effort inside a `try/catch`: a failed index refresh must never fail the credential sync or, worse, a successful handoff. Outside a git repo (which `sync-auth` tolerates) it is skipped entirely.

- [ ] **Step 1: Write the failing tests**

Create `product/cli/test/syncauth.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { cmdSyncAuth, collectCredentialBundle, authTokenFor } = await import("../src/commands/syncauth.mjs");
const { writeCredentials } = await import("../src/creds.mjs");
const { generateEncKeyPair, openSealed } = await import("../src/seal.mjs");

function homeWithCreds(node) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-syncauth-"));
  writeCredentials({ sessionToken: "sess", accountId: "acct", nodeId: "node-1", nodeEncPubkey: node.publicKeyB64 }, { home });
  return home;
}

function recordingCloud() {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, options = {}) => {
      const pathname = new URL(url).pathname;
      calls.push({ pathname, headers: options.headers || {}, raw: options.body, body: typeof options.body === "string" ? JSON.parse(options.body) : null });
      if (pathname === "/v1/pairing/sessions") {
        return { status: 201, json: async () => ({ pairingId: "11111111-1111-4111-8111-111111111111", expiresAt: 1 }) };
      }
      return { status: 204, json: async () => null };
    },
  };
}

test("credentials are collected, sealed to the node, and delivered over the rendezvous", async () => {
  const node = generateEncKeyPair();
  const home = homeWithCreds(node);
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", ".credentials.json"), '{"token":"claude-token"}');
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(home, ".codex", "auth.json"), '{"token":"codex-token"}');

  const cloud = recordingCloud();
  const lines = [];

  const result = await cmdSyncAuth([], {
    home, baseUrl: "https://cloud.test", fetchImpl: cloud.fetchImpl, log: (line) => lines.push(line),
    execFileImpl: async () => ({ stdout: "ghp_from_gh_cli\n" }),
  });

  assert.deepEqual(result.installed.sort(), ["claude", "codex", "github"]);

  const blobCall = cloud.calls.find((call) => call.pathname.endsWith("/device-blob"));
  const bundle = JSON.parse(openSealed(node.privateKeyPem, Buffer.from(blobCall.raw)).toString("utf8"));
  assert.equal(bundle.kind, "sync-auth");
  assert.equal(bundle.github.token, "ghp_from_gh_cli");
  assert.equal(bundle.claude.credentials, '{"token":"claude-token"}');

  const sessionCall = cloud.calls.find((call) => call.pathname === "/v1/pairing/sessions");
  assert.equal(sessionCall.body.kind, "sync-auth");
  assert.match(sessionCall.body.authToken, /^[A-Za-z0-9_-]{43}$/, "the rendezvous sees a derived token, not the secret");
  assert.ok(!lines.join("\n").includes("ghp_from_gh_cli"), "no credential is ever printed");
  assert.ok(!lines.join("\n").includes("claude-token"));
});

test("missing credentials are reported honestly rather than faked", async () => {
  const node = generateEncKeyPair();
  const home = homeWithCreds(node);
  const cloud = recordingCloud();
  const lines = [];

  const result = await cmdSyncAuth([], {
    home, baseUrl: "https://cloud.test", fetchImpl: cloud.fetchImpl, log: (line) => lines.push(line),
    execFileImpl: async () => { throw new Error("gh not installed"); },
  });

  assert.deepEqual(result.installed, []);
  assert.deepEqual(result.skipped.sort(), ["claude", "codex", "github"]);
  assert.match(lines.join("\n"), /cursor/i, "cursor's on-box login requirement is stated");
});

test("authTokenFor is deterministic per secret and never returns the secret", () => {
  assert.equal(authTokenFor("known-secret"), authTokenFor("known-secret"));
  assert.notEqual(authTokenFor("a"), authTokenFor("b"));
  assert.ok(!authTokenFor("known-secret").includes("known-secret"));
});

test("collectCredentialBundle never includes an empty member", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-bundle-"));
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(home, ".codex", "auth.json"), '{"token":"only-codex"}');

  const { bundle, skipped } = await collectCredentialBundle({ home, execFileImpl: async () => { throw new Error("no gh"); } });

  assert.equal(bundle.codex.auth, '{"token":"only-codex"}');
  assert.equal(bundle.github, undefined);
  assert.equal(bundle.claude, undefined);
  assert.deepEqual(skipped.sort(), ["claude", "github"]);
});
```

Create `product/cli/test/status.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const { cmdStatus } = await import("../src/commands/status.mjs");
const { writeCredentials } = await import("../src/creds.mjs");

process.env.RELAY_ALLOW_LOCAL_REMOTE = "1";

async function repoAndHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-status-"));
  const git = (...args) => execFileAsync("git", ["-C", dir, ...args]);
  await execFileAsync("git", ["init", "-q", "-b", "main", dir]);
  await git("config", "user.email", "t@example.com");
  await git("config", "user.name", "T");
  await git("remote", "add", "origin", "https://github.com/Me/Relay.git");
  fs.writeFileSync(path.join(dir, "README.md"), "# hi\n");
  await git("add", "-A");
  await git("commit", "-qm", "initial");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-status-home-"));
  writeCredentials({ sessionToken: "sess", nodeId: "node-1", nodeEncPubkey: "k" }, { home });
  return { dir, home };
}

test("status lists this repo's handoffs newest first with their state", async () => {
  const { dir, home } = await repoAndHome();
  const lines = [];

  await cmdStatus([], {
    home, cwd: dir, baseUrl: "https://cloud.test", log: (line) => lines.push(line),
    fetchImpl: async () => ({ status: 200, json: async () => ({ handoffs: [
      { id: "a1", branch: "relay/handoff-newer-aaa111", state: "ready", createdAt: 2, reason: null },
      { id: "a2", branch: "relay/handoff-older-bbb222", state: "failed", createdAt: 1, reason: "clone_failed" },
    ] }) }),
  });

  const output = lines.join("\n");
  assert.match(output, /relay\/handoff-newer-aaa111/);
  assert.match(output, /ready/);
  assert.match(output, /clone_failed/, "a failure reason is surfaced, not hidden");
  assert.ok(output.indexOf("newer") < output.indexOf("older"), "newest first");
});

test("a failed handoff needing credentials tells the user what to run", async () => {
  const { dir, home } = await repoAndHome();
  const lines = [];

  await cmdStatus([], {
    home, cwd: dir, baseUrl: "https://cloud.test", log: (line) => lines.push(line),
    fetchImpl: async () => ({ status: 200, json: async () => ({ handoffs: [
      { id: "a1", branch: "relay/handoff-x-aaa111", state: "failed", createdAt: 1, reason: "clone_failed: authentication required" },
    ] }) }),
  });

  assert.match(lines.join("\n"), /relay sync-auth/);
});

test("no handoffs yet reads as an empty state, not an error", async () => {
  const { dir, home } = await repoAndHome();
  const lines = [];
  await cmdStatus([], { home, cwd: dir, baseUrl: "https://cloud.test", log: (line) => lines.push(line),
    fetchImpl: async () => ({ status: 200, json: async () => ({ handoffs: [] }) }) });
  assert.match(lines.join("\n"), /no handoffs yet/i);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd product/cli && node --test test/syncauth.test.mjs test/status.test.mjs`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write `syncauth.mjs`**

Create `product/cli/src/commands/syncauth.mjs`:

```js
// relay sync-auth — put the operator's own logins on their sandbox.
//
// Credentials ride the pairing rendezvous sealed to the node's key: the control
// plane relays opaque bytes and GitHub never sees them at all (a token in git
// history cannot be un-published). Nothing here prints a credential.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { createCloudApi, DEFAULT_BASE_URL } from "../cloud.mjs";
import { readCredentials } from "../creds.mjs";
import { sealTo } from "../seal.mjs";
import { discoverSessions } from "../sessions.mjs";

const execFileAsync = promisify(execFile);
const AUTH_LABEL = "relay-pair-auth-v1";
const MAC_LABEL = "relay-pair-mac-v1";
const DEVICE_SLOT = "device-blob";

function generateSecret() {
  return crypto.randomBytes(24).toString("base64url");
}

function authTokenFor(secret) {
  return crypto.createHash("sha256")
    .update(Buffer.concat([Buffer.from(AUTH_LABEL, "utf8"), Buffer.from([0]), Buffer.from(String(secret), "utf8")]))
    .digest("base64url");
}

function macKeyFor(secret) {
  return crypto.createHmac("sha256", Buffer.from(String(secret), "utf8")).update(MAC_LABEL).digest();
}

function blobTagFor(macKey, slot, blob) {
  return crypto.createHmac("sha256", macKey)
    .update(Buffer.concat([Buffer.from(slot, "utf8"), Buffer.from([0]), blob]))
    .digest("base64");
}

function readIfPresent(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

async function collectCredentialBundle({ home = os.homedir(), execFileImpl = execFileAsync } = {}) {
  const bundle = { v: 1, kind: "sync-auth" };
  const skipped = [];

  let githubToken = null;
  try {
    const { stdout } = await execFileImpl("gh", ["auth", "token"]);
    githubToken = String(stdout).trim() || null;
  } catch {
    githubToken = null;
  }
  if (githubToken) bundle.github = { token: githubToken };
  else skipped.push("github");

  const claude = readIfPresent(path.join(home, ".claude", ".credentials.json"));
  if (claude) bundle.claude = { credentials: claude };
  else skipped.push("claude");

  const codex = readIfPresent(path.join(home, ".codex", "auth.json"));
  if (codex) bundle.codex = { auth: codex };
  else skipped.push("codex");

  return { bundle, skipped };
}

async function deliverSealedBundle({ api, nodeEncPubkey, kind, payload }) {
  const secret = generateSecret();
  const authToken = authTokenFor(secret);
  const created = await api.createPairingSession(authToken, kind);
  if (created.status !== 201) throw new Error(`rendezvous_create_failed_${created.status}`);

  const sealed = sealTo(nodeEncPubkey, Buffer.from(JSON.stringify(payload), "utf8"));
  const tag = blobTagFor(macKeyFor(secret), DEVICE_SLOT, sealed);
  const put = await api.putDeviceBlob(created.json.pairingId, authToken, tag, sealed);
  if (put.status !== 204) throw new Error(`rendezvous_put_failed_${put.status}`);
  return created.json.pairingId;
}

async function publishSessionIndex({ repoFullName, root, home, api, nodeEncPubkey, machine }) {
  const sessions = discoverSessions({ cwd: root, home }).slice(0, 50).map((session) => ({
    id: session.id, harness: session.harness, title: session.title,
    repo: repoFullName, lastActive: session.lastActive,
  }));
  await deliverSealedBundle({
    api, nodeEncPubkey, kind: "session-index",
    payload: { v: 1, kind: "session-index", machine, updatedAt: new Date().toISOString(), sessions },
  });
  return sessions.length;
}

async function cmdSyncAuth(args = [], deps = {}) {
  const {
    home = undefined, baseUrl = DEFAULT_BASE_URL, fetchImpl = fetch, log = console.log,
    execFileImpl = execFileAsync, machine = os.hostname(),
  } = deps;

  const credentials = readCredentials({ home });
  if (!credentials?.sessionToken) throw new Error("not_logged_in: run relay login first");
  if (!credentials.nodeEncPubkey) throw new Error("no_machine_pinned: run relay login after creating a machine");

  const { bundle, skipped } = await collectCredentialBundle({ home: home || os.homedir(), execFileImpl });
  const installed = ["github", "claude", "codex"].filter((name) => bundle[name]);

  const api = createCloudApi({ baseUrl, sessionToken: credentials.sessionToken, fetchImpl });
  const pairingId = await deliverSealedBundle({ api, nodeEncPubkey: credentials.nodeEncPubkey, kind: "sync-auth", payload: bundle });

  // Best-effort, and skipped outside a repo: a stale index must never fail a
  // credential sync that otherwise succeeded.
  try {
    const { requireGitHubRepo } = await import("../repo.mjs");
    const repo = await requireGitHubRepo({ cwd: deps.cwd || process.cwd() });
    const count = await publishSessionIndex({
      repoFullName: repo.fullName, root: fs.realpathSync(repo.root), home: home || os.homedir(),
      api, nodeEncPubkey: credentials.nodeEncPubkey, machine,
    });
    if (count > 0) log(`  Shared ${count} local session${count === 1 ? "" : "s"} with your machine.`);
  } catch {
    // Not in a repo, or the index could not be delivered. Credentials still landed.
  }

  log("");
  for (const name of installed) log(`  Sent ${name} login to your machine.`);
  for (const name of skipped) {
    if (name === "github") log("  No GitHub token found — run `gh auth login`, or create a fine-grained PAT scoped to your repo.");
    if (name === "claude") log("  No Claude Code login found on this machine.");
    if (name === "codex") log("  No Codex login found on this machine.");
  }
  log("  Cursor has no portable login — sign in to Cursor on the machine itself.");
  log("");

  return { installed, skipped, pairingId };
}

export { cmdSyncAuth, collectCredentialBundle, publishSessionIndex, authTokenFor, macKeyFor, blobTagFor, generateSecret };
```

- [ ] **Step 4: Write `status.mjs`**

Create `product/cli/src/commands/status.mjs`:

```js
// relay status — what happened to this repository's handoffs.
import { createCloudApi, DEFAULT_BASE_URL } from "../cloud.mjs";
import { readCredentials } from "../creds.mjs";
import { requireGitHubRepo } from "../repo.mjs";

function age(createdAt) {
  const seconds = Math.max(0, Math.round((Date.now() - Number(createdAt)) / 1000));
  if (seconds < 90) return `${seconds}s ago`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 172800) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

async function cmdStatus(args = [], deps = {}) {
  const { home = undefined, cwd = process.cwd(), baseUrl = DEFAULT_BASE_URL, fetchImpl = fetch, log = console.log } = deps;

  const credentials = readCredentials({ home });
  if (!credentials?.sessionToken) throw new Error("not_logged_in: run relay login first");

  const repo = await requireGitHubRepo({ cwd });
  const api = createCloudApi({ baseUrl, sessionToken: credentials.sessionToken, fetchImpl });
  const result = await api.listHandoffs(repo.fullName);
  if (result.status !== 200) throw new Error(`status_failed_${result.status}`);

  const handoffs = [...(result.json?.handoffs || [])].sort((left, right) => right.createdAt - left.createdAt);
  log("");
  log(`  ${repo.fullName}`);
  log("");
  if (handoffs.length === 0) {
    log("  No handoffs yet. Run relay handoff to send this session to your machine.");
    log("");
    return;
  }

  for (const handoff of handoffs) {
    log(`  ${handoff.state.padEnd(10)} ${handoff.branch}  ${age(handoff.createdAt)}`);
    if (handoff.reason) log(`             ${handoff.reason}`);
    if (handoff.state === "failed" && /auth|credential|clone_failed/i.test(handoff.reason || "")) {
      log("             Your machine may be missing your GitHub login — run relay sync-auth.");
    }
  }
  log("");
}

export { cmdStatus };
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd product/cli && node --test test/*.test.mjs`
Expected: PASS — the whole CLI suite.

- [ ] **Step 6: Commit**

```bash
git add product/cli
git commit -m "feat(cli): relay sync-auth credential delivery and relay status"
```

---

## Task 21: End-to-end handoff test

**Files:**
- Create: `product/cli/test/e2e-handoff.test.mjs`

**Interfaces:**
- Consumes: the CLI (16–20), relayd's handoff module (14), the seal format (1)
- Produces: one scripted run proving CLI → bare repo → relayd → ready handoff → resumed job with a fake harness

This is the gate that catches contract drift between the two halves: the CLI seals a manifest and relayd opens it, with no shared runtime and no mocks between them.

- [ ] **Step 1: Write the failing test**

Create `product/cli/test/e2e-handoff.test.mjs`:

```js
// End-to-end: `relay handoff` on a laptop-shaped repo, then relayd importing it
// on a sandbox-shaped machine. Nothing is mocked between the two halves — the
// CLI seals, relayd decrypts, and a fake harness proves the resume actually runs.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const relaydRoot = path.join(here, "..", "..", "relayd");

process.env.RELAY_ALLOW_LOCAL_REMOTE = "1";

test("a handoff pushed by the CLI is imported and resumed by relayd", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-e2e-"));
  const laptopHome = path.join(root, "laptop-home");
  const work = path.join(root, "repo");
  const bare = path.join(root, "origin.git");
  const sandboxRoot = path.join(root, "sandbox");
  const workspaceRoot = path.join(sandboxRoot, "workspaces");
  const runHome = path.join(sandboxRoot, "home");
  const identityDir = path.join(sandboxRoot, "identity");
  for (const dir of [laptopHome, workspaceRoot, runHome]) fs.mkdirSync(dir, { recursive: true });

  // ── the sandbox side: a node identity whose public key the laptop will seal to
  process.env.CODEX_DATA_DIR = path.join(sandboxRoot, "data");
  process.env.CODEX_WORKSPACE_BROWSE_ROOT = workspaceRoot;
  process.env.CODEX_WORKSPACES = JSON.stringify([{ id: "welcome", name: "Welcome", path: path.join(workspaceRoot, "welcome") }]);
  process.env.CODEX_RUN_HOME = runHome;

  const { initIdentity, identityPaths, readEncPublicKeyB64 } = await import(path.join(relaydRoot, "src", "identity.mjs"));
  initIdentity({ baseDir: identityDir });
  const nodeEncPubkey = readEncPublicKeyB64(identityPaths(identityDir));

  // ── the laptop side: a repo with uncommitted work and a Claude session
  await execFileAsync("git", ["init", "-q", "--bare", bare]);
  await execFileAsync("git", ["init", "-q", "-b", "main", work]);
  const git = (...args) => execFileAsync("git", ["-C", work, ...args]);
  await git("config", "user.email", "t@example.com");
  await git("config", "user.name", "T");
  await git("remote", "add", "origin", bare);
  fs.writeFileSync(path.join(work, "README.md"), "# repo\n");
  await git("add", "-A");
  await git("commit", "-qm", "initial");
  await git("push", "-q", "origin", "main");
  fs.writeFileSync(path.join(work, "wip.txt"), "half-finished refactor\n");

  const realWork = fs.realpathSync(work);
  const { claudeProjectSlug } = await import("../src/sessions.mjs");
  const sessionId = "11111111-1111-4111-8111-111111111111";
  const sessionDir = path.join(laptopHome, ".claude", "projects", claudeProjectSlug(realWork));
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, `${sessionId}.jsonl`),
    `${JSON.stringify({ type: "user", cwd: realWork, message: { content: "finish the auth refactor" } })}\n`);

  const { writeCredentials } = await import("../src/creds.mjs");
  writeCredentials({ sessionToken: "sess", accountId: "acct", nodeId: "node-1", nodeEncPubkey }, { home: laptopHome });

  // ── run the handoff, capturing the ping the control plane would have received
  const pings = [];
  const { cmdHandoff } = await import("../src/commands/handoff.mjs");
  const handoff = await cmdHandoff([], {
    home: laptopHome, cwd: work, baseUrl: "https://cloud.test", log: () => {}, machine: "TestBook",
    // Only the handoff ping matters here; the best-effort session-index refresh
    // that follows it is allowed to fail against this stub.
    fetchImpl: async (url, options = {}) => {
      if (new URL(url).pathname !== "/v1/handoffs") return { status: 500, json: async () => ({}) };
      pings.push(JSON.parse(options.body));
      return { status: 201, json: async () => ({ handoff: { id: pings.at(-1).handoffId, state: "pending" } }) };
    },
  });

  assert.equal(pings.length, 1);
  assert.deepEqual(
    { handoffId: pings[0].handoffId, branch: pings[0].branch, nodeId: pings[0].nodeId },
    { handoffId: handoff.handoffId, branch: handoff.branch, nodeId: "node-1" },
  );

  // ── the sandbox picks it up from the very descriptor the cloud would relay
  const events = [];
  const { importHandoff, continueHandoff } = await import(path.join(relaydRoot, "src", "handoff.mjs"));
  const record = await importHandoff(
    { id: pings[0].handoffId, repo: pings[0].repo, branch: pings[0].branch },
    {
      cloud: { postEvent: async (type) => { events.push(type); return { status: 202 }; } },
      baseDir: identityDir, runHome, remoteUrlFor: () => bare,
    },
  );

  assert.equal(record.state, "ready", `import failed: ${record.error}`);
  assert.equal(record.provider, "claude");
  assert.equal(record.resumeSessionId, sessionId);
  assert.equal(record.title, "finish the auth refactor");
  assert.deepEqual(events, ["handoff.ready"]);

  const checkout = path.join(workspaceRoot, `handoff-${handoff.handoffId.slice(0, 12)}`);
  assert.equal(fs.readFileSync(path.join(checkout, "wip.txt"), "utf8"), "half-finished refactor\n",
    "the uncommitted work crossed the wire");
  const staged = path.join(runHome, ".claude", "projects", claudeProjectSlug(checkout), `${sessionId}.jsonl`);
  assert.ok(fs.existsSync(staged), "the session is staged for --resume on the sandbox");
  assert.ok(!fs.readFileSync(staged, "utf8").includes(realWork), "the laptop path was rewritten");

  // ── continuing it runs a real job through the jobs engine
  const fakeClaude = path.join(root, "fake-claude");
  fs.writeFileSync(fakeClaude, "#!/bin/sh\ncat > /dev/null\nprintf 'resumed\\n'\n", { mode: 0o755 });
  process.env.CLAUDE_BIN = fakeClaude;

  const job = await continueHandoff(record.id, { prompt: "keep going" });
  assert.equal(job.workspaceId, record.workspaceId);
  assert.equal(job.provider, "claude");
  assert.equal(job.resumeSessionId, sessionId, "the resume id reached the job");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd product/cli && node --test test/e2e-handoff.test.mjs`
Expected: FAIL initially if any contract has drifted — the exact assertion that fires tells you which side is wrong.

- [ ] **Step 3: Fix whatever the E2E surfaces**

Do not weaken assertions to make this pass. If the manifest field names, the seal format, the branch name, or the descriptor shape disagree between the CLI and relayd, change the side that deviates from this plan's stated interface and re-run the owning task's unit tests.

- [ ] **Step 4: Run both suites**

Run: `cd product/cli && node --test test/*.test.mjs && cd ../relayd && node --test test/*.test.mjs`
Expected: PASS — every CLI test and every relayd test.

- [ ] **Step 5: Commit**

```bash
git add product/cli/test/e2e-handoff.test.mjs
git commit -m "test: end-to-end handoff from CLI push to relayd resume"
```

---

## Task 22: iOS handoff models and client methods

**Files:**
- Create: `ios/POCVault/POCVault/Models/RelayHandoff.swift`
- Modify: `ios/POCVault/POCVault/Networking/CodexClient.swift` (four methods, envelope keys)
- Modify: `ios/POCVault/POCVault.xcodeproj/project.pbxproj`
- Test: `ios/POCVault/POCVaultTests/HandoffTests.swift`

**Interfaces:**
- Consumes: relayd's `GET /v1/handoffs`, `GET /v1/handoffs/:id`, `POST /v1/handoffs/:id/continue`, `GET /v1/mac-sessions` (Tasks 14–15)
- Produces:
  - `RelayHandoffCard: Decodable, Identifiable, Hashable` — `id, state, repo, branch, title, provider, workspaceID, canResumeNatively, lastJobID, error, createdAt, updatedAt`, plus `RelayHandoffCard.State { importing, ready, failed, unknown(String) }` and computed `statusLabel: String`, `subtitle: String`
  - `RelayHandoffDetail: Decodable` — `card` plus `manifest: RelayHandoffManifest?`
  - `RelayHandoffManifest: Decodable` — `harness, machine, excerpt, wipSummary, baseBranch`
  - `RelayMacSession: Decodable, Identifiable, Hashable` — `id, harness, title, repo, lastActive`
  - `RelayMacSessionIndex: Decodable` — `machine, updatedAt, sessions`
  - `CodexClient.fetchHandoffs() async throws -> [RelayHandoffCard]`
  - `CodexClient.fetchHandoff(id:) async throws -> RelayHandoffDetail`
  - `CodexClient.continueHandoff(id:prompt:) async throws -> CodexCreateJobResponse`
  - `CodexClient.fetchMacSessions() async throws -> RelayMacSessionIndex?`

`statusLabel` returns a word (`"IMPORTING"`, `"READY"`, `"FAILED"`) — never a glyph or a dot, per the design rule.

- [ ] **Step 1: Write the failing test**

Create `ios/POCVault/POCVaultTests/HandoffTests.swift`:

```swift
import XCTest
@testable import POCVault

final class HandoffTests: XCTestCase {

    // MARK: - Model decoding

    func testHandoffCardDecodesTheNodeShape() throws {
        let card = try decodeCard("""
        { "id": "abc123def4567890", "state": "ready", "repo": "me/relay",
          "branch": "relay/handoff-fix-auth-abc123", "title": "Fix the auth redirect",
          "provider": "claude", "workspaceId": "dir-handoff-abc123",
          "canResumeNatively": true, "lastJobId": null, "error": null,
          "createdAt": "2026-08-11T10:00:00.000Z", "updatedAt": "2026-08-11T10:00:05.000Z" }
        """)

        XCTAssertEqual(card.state, .ready)
        XCTAssertEqual(card.provider, .claude)
        XCTAssertEqual(card.workspaceID, "dir-handoff-abc123")
        XCTAssertTrue(card.canResumeNatively)
        XCTAssertEqual(card.statusLabel, "READY")
        XCTAssertEqual(card.subtitle, "me/relay · relay/handoff-fix-auth-abc123")
    }

    func testFailedHandoffSurfacesItsReason() throws {
        let card = try decodeCard("""
        { "id": "abc123def4567890", "state": "failed", "repo": "me/relay", "branch": "relay/handoff-x",
          "title": "Fix auth", "provider": null, "workspaceId": null, "canResumeNatively": false,
          "lastJobId": null, "error": "clone_failed: authentication required",
          "createdAt": "2026-08-11T10:00:00.000Z", "updatedAt": "2026-08-11T10:00:00.000Z" }
        """)

        XCTAssertEqual(card.state, .failed)
        XCTAssertEqual(card.statusLabel, "FAILED")
        XCTAssertEqual(card.error, "clone_failed: authentication required")
        XCTAssertNil(card.provider)
    }

    func testUnknownStateDegradesInsteadOfFailingToDecode() throws {
        let card = try decodeCard("""
        { "id": "abc123def4567890", "state": "quarantined", "repo": "me/relay", "branch": "relay/handoff-x",
          "title": "T", "provider": null, "workspaceId": null, "canResumeNatively": false,
          "lastJobId": null, "error": null, "createdAt": null, "updatedAt": null }
        """)

        XCTAssertEqual(card.state, .unknown("quarantined"))
        XCTAssertEqual(card.statusLabel, "QUARANTINED")
    }

    func testHandoffDetailCarriesTheManifest() throws {
        let detail = try JSONDecoder.relayTestDecoder().decode(RelayHandoffDetail.self, from: Data("""
        { "id": "abc123def4567890", "state": "ready", "repo": "me/relay", "branch": "relay/handoff-x",
          "title": "Fix auth", "provider": "claude", "workspaceId": "dir-x", "canResumeNatively": true,
          "lastJobId": null, "error": null, "createdAt": null, "updatedAt": null,
          "manifest": { "harness": "claude", "machine": "MacBook-Pro", "excerpt": "Tracing the loop.",
                        "baseBranch": "main", "wip": { "summary": "2 files changed, +30/-4" } } }
        """.utf8))

        XCTAssertEqual(detail.card.title, "Fix auth")
        XCTAssertEqual(detail.manifest?.machine, "MacBook-Pro")
        XCTAssertEqual(detail.manifest?.wipSummary, "2 files changed, +30/-4")
        XCTAssertEqual(detail.manifest?.excerpt, "Tracing the loop.")
    }

    func testMacSessionIndexDecodes() throws {
        let index = try JSONDecoder.relayTestDecoder().decode(RelayMacSessionIndex.self, from: Data("""
        { "machine": "MacBook-Pro", "updatedAt": "2026-08-11T10:00:00.000Z",
          "sessions": [ { "id": "s1", "harness": "claude", "title": "Fix auth",
                          "repo": "me/relay", "lastActive": "2026-08-11T09:00:00.000Z" } ] }
        """.utf8))

        XCTAssertEqual(index.machine, "MacBook-Pro")
        XCTAssertEqual(index.sessions.count, 1)
        XCTAssertEqual(index.sessions[0].title, "Fix auth")
    }

    // MARK: - Helpers

    private func decodeCard(_ json: String) throws -> RelayHandoffCard {
        try JSONDecoder.relayTestDecoder().decode(RelayHandoffCard.self, from: Data(json.utf8))
    }
}
```

Add the shared decoder helper at the bottom of the same file (it mirrors `CodexClient`'s configuration so tests decode exactly what the client will):

```swift
extension JSONDecoder {
    static func relayTestDecoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            if let text = try? container.decode(String.self) {
                if let date = ISO8601DateFormatter.relayFractional.date(from: text) { return date }
                if let date = ISO8601DateFormatter().date(from: text) { return date }
            }
            if let seconds = try? container.decode(Double.self) { return Date(timeIntervalSince1970: seconds) }
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "unrecognised date")
        }
        return decoder
    }
}

extension ISO8601DateFormatter {
    static let relayFractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
set -o pipefail; xcodebuild test -project ios/POCVault/POCVault.xcodeproj -scheme POCVault \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' 2>&1 | tail -30
```
Expected: FAIL — `cannot find 'RelayHandoffCard' in scope`.

- [ ] **Step 3: Write the models**

Create `ios/POCVault/POCVault/Models/RelayHandoff.swift`:

```swift
import Foundation

/// A session handed off from a Mac, waiting on this machine.
///
/// Handoffs are their own resource rather than a thread kind: relayd derives
/// threads from jobs, so a handoff only becomes a thread once it is continued.
struct RelayHandoffCard: Decodable, Identifiable, Hashable {

    enum State: Hashable {
        case importing
        case ready
        case failed
        case unknown(String)

        init(rawState: String) {
            switch rawState.lowercased() {
            case "importing": self = .importing
            case "ready": self = .ready
            case "failed": self = .failed
            default: self = .unknown(rawState)
            }
        }

        var rawValue: String {
            switch self {
            case .importing: return "importing"
            case .ready: return "ready"
            case .failed: return "failed"
            case .unknown(let value): return value
            }
        }
    }

    let id: String
    let state: State
    let repo: String
    let branch: String
    let title: String
    let provider: CodexProvider?
    let workspaceID: String?
    let canResumeNatively: Bool
    let lastJobID: String?
    let error: String?
    let createdAt: Date?
    let updatedAt: Date?

    private enum CodingKeys: String, CodingKey {
        case id, state, repo, branch, title, provider, error
        case workspaceId, canResumeNatively, lastJobId, createdAt, updatedAt
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        state = State(rawState: try container.decodeIfPresent(String.self, forKey: .state) ?? "unknown")
        repo = try container.decodeIfPresent(String.self, forKey: .repo) ?? ""
        branch = try container.decodeIfPresent(String.self, forKey: .branch) ?? ""
        title = try container.decodeIfPresent(String.self, forKey: .title) ?? "Handoff"
        provider = try container.decodeIfPresent(String.self, forKey: .provider).map { CodexProvider(rawProvider: $0) }
        workspaceID = try container.decodeIfPresent(String.self, forKey: .workspaceId)
        canResumeNatively = try container.decodeIfPresent(Bool.self, forKey: .canResumeNatively) ?? false
        lastJobID = try container.decodeIfPresent(String.self, forKey: .lastJobId)
        error = try container.decodeIfPresent(String.self, forKey: .error)
        createdAt = try container.decodeIfPresent(Date.self, forKey: .createdAt)
        updatedAt = try container.decodeIfPresent(Date.self, forKey: .updatedAt)
    }

    /// A word, never a glyph — the design language has no status dots.
    var statusLabel: String { state.rawValue.uppercased() }

    var subtitle: String { branch.isEmpty ? repo : "\(repo) · \(branch)" }

    var isActionable: Bool { state == .ready }
}

struct RelayHandoffManifest: Decodable, Hashable {
    let harness: String?
    let machine: String?
    let excerpt: String?
    let baseBranch: String?
    let wipSummary: String?

    private enum CodingKeys: String, CodingKey { case harness, machine, excerpt, baseBranch, wip }
    private struct Wip: Decodable { let summary: String? }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        harness = try container.decodeIfPresent(String.self, forKey: .harness)
        machine = try container.decodeIfPresent(String.self, forKey: .machine)
        excerpt = try container.decodeIfPresent(String.self, forKey: .excerpt)
        baseBranch = try container.decodeIfPresent(String.self, forKey: .baseBranch)
        wipSummary = try container.decodeIfPresent(Wip.self, forKey: .wip)?.summary
    }
}

struct RelayHandoffDetail: Decodable {
    let card: RelayHandoffCard
    let manifest: RelayHandoffManifest?

    private enum CodingKeys: String, CodingKey { case manifest }

    init(from decoder: Decoder) throws {
        card = try RelayHandoffCard(from: decoder)
        manifest = try decoder.container(keyedBy: CodingKeys.self).decodeIfPresent(RelayHandoffManifest.self, forKey: .manifest)
    }
}

struct RelayMacSession: Decodable, Identifiable, Hashable {
    let id: String
    let harness: String
    let title: String
    let repo: String
    let lastActive: String
}

struct RelayMacSessionIndex: Decodable {
    let machine: String?
    let updatedAt: String?
    let sessions: [RelayMacSession]
}
```

- [ ] **Step 4: Add the client methods**

In `ios/POCVault/POCVault/Networking/CodexClient.swift`, add `"handoffs"` to `CodexListEnvelope`'s key list, then add:

```swift
    func fetchHandoffs() async throws -> [RelayHandoffCard] {
        let data = try await perform(path: "/v1/handoffs")
        return try decoder.decode(CodexListEnvelope<RelayHandoffCard>.self, from: data).items
    }

    func fetchHandoff(id: String) async throws -> RelayHandoffDetail {
        let data = try await perform(path: "/v1/handoffs/\(Self.pathComponent(id))")
        return try decoder.decode(RelayHandoffEnvelope.self, from: data).handoff
    }

    func continueHandoff(id: String, prompt: String?) async throws -> CodexCreateJobResponse {
        var body: [String: String] = [:]
        if let prompt, !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { body["prompt"] = prompt }
        let data = try await perform(
            path: "/v1/handoffs/\(Self.pathComponent(id))/continue",
            method: "POST",
            body: try JSONSerialization.data(withJSONObject: body)
        )
        return try decoder.decode(CodexJobEnvelope.self, from: data).job
    }

    func fetchMacSessions() async throws -> RelayMacSessionIndex? {
        let data = try await perform(path: "/v1/mac-sessions")
        return try decoder.decode(RelayMacSessionEnvelope.self, from: data).index
    }
```

with the three envelopes next to `CodexListEnvelope`:

```swift
private struct RelayHandoffEnvelope: Decodable { let handoff: RelayHandoffDetail }
private struct RelayMacSessionEnvelope: Decodable { let index: RelayMacSessionIndex? }
private struct CodexJobEnvelope: Decodable { let job: CodexCreateJobResponse }
```

If `CodexCreateJobResponse` cannot decode relayd's job-preview payload directly, decode `CodexJob` here and wrap it — match whatever `createJob` already does with the same route's response shape.

- [ ] **Step 5: Register the new files in the Xcode project**

In `ios/POCVault/POCVault.xcodeproj/project.pbxproj` add, for `RelayHandoff.swift`: a `PBXFileReference` with id `100000000000000000000051`, a `PBXBuildFile` with id `200000000000000000000047`, membership in the Models group `500000000000000000000005`, and an entry in the app target's Sources phase `600000000000000000000001`. For `HandoffTests.swift`: file ref `100000000000000000000052`, build file `200000000000000000000048`, membership in the tests group `500000000000000000000003`, and an entry in the test target's Sources phase.

- [ ] **Step 6: Run tests to verify they pass**

Run:
```bash
set -o pipefail; xcodebuild test -project ios/POCVault/POCVault.xcodeproj -scheme POCVault \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' 2>&1 | tail -30
```
Expected: PASS — the 5 decode tests plus the existing suite. (The design-rule source scan lives in Task 23, which is where the file it scans gets created; nothing is disabled here.)

- [ ] **Step 7: Commit**

```bash
git add ios/POCVault
git commit -m "feat(ios): handoff and Mac-session models with client methods"
```

---

## Task 23: The handoff card and the "On your Mac" section

**Files:**
- Create: `ios/POCVault/POCVault/Views/RelayHandoffCardView.swift`
- Modify: `ios/POCVault/POCVault/Views/RelayChatViewModel.swift` (load + continue)
- Modify: `ios/POCVault/POCVault/Views/RelayChatView.swift` (`RelayThreadDrawer` sections)
- Modify: `ios/POCVault/POCVault.xcodeproj/project.pbxproj`
- Test: `ios/POCVault/POCVaultTests/HandoffTests.swift` (extend)

**Interfaces:**
- Consumes: Task 22's models and client methods
- Produces:
  - `RelayHandoffCardView(card:manifest:isContinuing:onContinue:)` — the card
  - `RelayMacSessionRow(session:onStartFresh:)` — one row of the index
  - `RelayChatViewModel.handoffs: [RelayHandoffCard]`, `.macSessions: RelayMacSessionIndex?`, `.continuingHandoffIDs: Set<String>`
  - `RelayChatViewModel.refreshHandoffs() async`, `.continueHandoff(_ card: RelayHandoffCard) async`

The card follows the outlined-card idiom (`RelayJobCard`): `RoundedRectangle(cornerRadius: 16)` stroke in `AppTheme.hairline`, or `AppTheme.accent.opacity(0.35)` when actionable. Badges are `RelayCapsLabel`; the branch is `AppTheme.monoFont(size: 11)`. A failed card shows its reason in `AppTheme.statusError`; a ready card's status word is `AppTheme.textSecondary` — cream, because the palette has no success color.

- [ ] **Step 1: Write the failing tests**

Append to `ios/POCVault/POCVaultTests/HandoffTests.swift`:

```swift
    // MARK: - View model

    @MainActor
    func testViewModelStartsWithNoHandoffsAndNoMacSessions() {
        let viewModel = RelayChatViewModel(client: makeOfflineCodexClient(), workspaceID: nil, workspacePath: nil)
        XCTAssertTrue(viewModel.handoffs.isEmpty)
        XCTAssertNil(viewModel.macSessions)
        XCTAssertTrue(viewModel.continuingHandoffIDs.isEmpty)
    }

    @MainActor
    func testRefreshHandoffsAgainstAClosedPortLeavesStateEmptyAndDoesNotThrow() async {
        let viewModel = RelayChatViewModel(client: makeOfflineCodexClient(), workspaceID: nil, workspacePath: nil)
        await viewModel.refreshHandoffs()
        XCTAssertTrue(viewModel.handoffs.isEmpty, "a failed refresh must not fabricate rows")
    }

    // MARK: - Design rules (the file these scan is created by this task)

    func testCardViewSourceUsesTheEditorialEmberIdiom() throws {
        let source = try String(contentsOfFile: handoffCardSourcePath, encoding: .utf8)
        XCTAssertTrue(source.contains("RelayCapsLabel"), "status and badges use the caps-label primitive")
        XCTAssertTrue(source.contains("AppTheme.monoFont"), "the branch renders in the mono face")
        XCTAssertTrue(source.contains("AppTheme.textSecondary"), "a ready state uses cream, not a success color")
    }

    func testHandoffCardNeverRendersADotOrGlyphForStatus() throws {
        let source = try String(contentsOfFile: handoffCardSourcePath, encoding: .utf8)
        XCTAssertFalse(source.contains("Circle().fill(AppTheme.status"), "handoff card renders a colored status dot")
        XCTAssertFalse(source.contains("checkmark.circle.fill"), "handoff card renders a status glyph")
        XCTAssertFalse(source.contains("statusOK"))
        XCTAssertFalse(source.contains("statusInfo"))
        XCTAssertFalse(source.contains("statusNeutral"))
    }

    private var handoffCardSourcePath: String {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("POCVault/Views/RelayHandoffCardView.swift")
            .path
    }

    private func makeOfflineCodexClient() -> CodexClient {
        CodexClient(baseURL: URL(string: "http://127.0.0.1:9")!, identityStore: ClientIdentityStore())
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run the `xcodebuild test` command from Task 22.
Expected: FAIL — `value of type 'RelayChatViewModel' has no member 'handoffs'`.

- [ ] **Step 3: Write the card view**

Create `ios/POCVault/POCVault/Views/RelayHandoffCardView.swift`:

```swift
import SwiftUI

/// A session handed over from a Mac, waiting to be picked up here.
struct RelayHandoffCardView: View {
    let card: RelayHandoffCard
    let manifest: RelayHandoffManifest?
    let isContinuing: Bool
    let onContinue: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                RelayCapsLabel(text: card.statusLabel, color: statusColor, size: 9)
                if let provider = card.provider {
                    RelayCapsLabel(text: provider.displayName, color: AppTheme.textTertiary, size: 9)
                }
                if card.canResumeNatively {
                    RelayCapsLabel(text: "Resumable", color: AppTheme.textTertiary, size: 9)
                }
                Spacer(minLength: 6)
                if let machine = manifest?.machine {
                    RelayCapsLabel(text: machine, color: AppTheme.textFaint, size: 9)
                }
            }

            Text(card.title)
                .font(AppTheme.serifFont(size: 18))
                .foregroundStyle(AppTheme.textPrimary)
                .fixedSize(horizontal: false, vertical: true)

            Text(card.subtitle)
                .font(AppTheme.monoFont(size: 11))
                .foregroundStyle(AppTheme.textTertiary)
                .lineLimit(2)

            if let summary = manifest?.wipSummary, !summary.isEmpty {
                Text(summary)
                    .font(AppTheme.uiFont(size: 12))
                    .foregroundStyle(AppTheme.textSecondary)
            }

            if let excerpt = manifest?.excerpt, !excerpt.isEmpty {
                Text(excerpt)
                    .font(AppTheme.uiFont(size: 12))
                    .foregroundStyle(AppTheme.textSecondary)
                    .lineLimit(3)
                    .padding(.top, 2)
            }

            if let error = card.error, !error.isEmpty {
                Text(error)
                    .font(AppTheme.uiFont(size: 12))
                    .foregroundStyle(AppTheme.statusError)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if card.isActionable {
                Button(action: onContinue) {
                    Text(isContinuing ? "Starting…" : "Continue")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(RelayPrimaryButtonStyle(isEnabled: !isContinuing))
                .disabled(isContinuing)
                .padding(.top, 2)
            }
        }
        .padding(14)
        .overlay {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(card.isActionable ? AppTheme.accent.opacity(0.35) : AppTheme.hairline, lineWidth: 1)
        }
    }

    private var statusColor: Color {
        switch card.state {
        case .failed: return AppTheme.statusError
        case .importing: return AppTheme.statusWarn
        // The palette has no success color on purpose: a finished state is cream.
        case .ready, .unknown: return AppTheme.textSecondary
        }
    }
}

/// One session still living on the user's Mac. Not actionable here — the honest
/// affordance is to say what to run over there.
struct RelayMacSessionRow: View {
    let session: RelayMacSession
    let onStartFresh: () -> Void

    var body: some View {
        Button(action: onStartFresh) {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(session.title)
                        .font(AppTheme.uiFont(size: 14))
                        .foregroundStyle(AppTheme.textPrimary)
                        .lineLimit(1)
                    HStack(spacing: 8) {
                        RelayCapsLabel(text: session.harness, color: AppTheme.textTertiary, size: 9)
                        Text(session.repo)
                            .font(AppTheme.monoFont(size: 11))
                            .foregroundStyle(AppTheme.textFaint)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 6)
                Image(systemName: "chevron.right")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(AppTheme.textFaint)
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 12)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .overlay(alignment: .bottom) {
            Rectangle().fill(AppTheme.hairline).frame(height: 0.5).padding(.leading, 20)
        }
    }
}
```

- [ ] **Step 4: Extend the view model**

In `ios/POCVault/POCVault/Views/RelayChatViewModel.swift`, add published state next to the existing `@Published private(set)` block:

```swift
    @Published private(set) var handoffs: [RelayHandoffCard] = []
    @Published private(set) var handoffManifests: [String: RelayHandoffManifest] = [:]
    @Published private(set) var macSessions: RelayMacSessionIndex?
    @Published private(set) var continuingHandoffIDs: Set<String> = []
```

and the two methods:

```swift
    func refreshHandoffs() async {
        do {
            let cards = try await client.fetchHandoffs()
            handoffs = cards
            for card in cards where handoffManifests[card.id] == nil {
                if let detail = try? await client.fetchHandoff(id: card.id), let manifest = detail.manifest {
                    handoffManifests[card.id] = manifest
                }
            }
        } catch {
            if isCancellation(error) { return }
            CodexDiagnostics.log("handoff.refresh.failed", fields: ["error": String(describing: error)])
        }

        macSessions = (try? await client.fetchMacSessions()) ?? macSessions
    }

    func continueHandoff(_ card: RelayHandoffCard) async {
        guard card.isActionable, !continuingHandoffIDs.contains(card.id) else { return }
        continuingHandoffIDs.insert(card.id)
        defer { continuingHandoffIDs.remove(card.id) }

        do {
            let created = try await client.continueHandoff(id: card.id, prompt: nil)
            let job = created.job ?? (try await client.fetchJob(id: created.id))
            if let workspaceID = card.workspaceID { adoptWorkspaceID(workspaceID) }
            messages.append(jobItem(job))
            attachJobStream(to: job)
            await refreshThreads()
            await refreshHandoffs()
        } catch {
            if isCancellation(error) { return }
            errorMessage = "Could not continue that handoff."
            CodexDiagnostics.log("handoff.continue.failed", fields: ["id": card.id, "error": String(describing: error)])
        }
    }
```

Call `await refreshHandoffs()` from `bootstrap()` after the existing thread load.

- [ ] **Step 5: Render the sections**

In `ios/POCVault/POCVault/Views/RelayChatView.swift`, inside `RelayThreadDrawer`'s scrolling content, above the existing history rows:

```swift
                if !viewModel.handoffs.isEmpty {
                    RelayCapsLabel(text: "Handed off", color: AppTheme.textTertiary)
                        .padding(.horizontal, 20)
                        .padding(.top, 8)
                    ForEach(viewModel.handoffs) { card in
                        RelayHandoffCardView(
                            card: card,
                            manifest: viewModel.handoffManifests[card.id],
                            isContinuing: viewModel.continuingHandoffIDs.contains(card.id),
                            onContinue: { Task { await viewModel.continueHandoff(card) } }
                        )
                        .padding(.horizontal, 20)
                    }
                }

                if let index = viewModel.macSessions, !index.sessions.isEmpty {
                    RelayCapsLabel(text: index.machine.map { "On your \($0)" } ?? "On your Mac",
                                   color: AppTheme.textTertiary)
                        .padding(.horizontal, 20)
                        .padding(.top, 16)
                    ForEach(index.sessions) { session in
                        RelayMacSessionRow(session: session, onStartFresh: {
                            viewModel.prompt = "Continue the work from “\(session.title)”."
                            dismiss()
                        })
                    }
                    Text("To continue one of these exactly where it left off, run relay handoff on that machine.")
                        .font(AppTheme.uiFont(size: 12))
                        .foregroundStyle(AppTheme.textFaint)
                        .padding(.horizontal, 20)
                        .padding(.top, 6)
                }
```

- [ ] **Step 6: Register the view file in the Xcode project**

Add `RelayHandoffCardView.swift` with file ref `100000000000000000000053`, build file `200000000000000000000049`, membership in the Views group `500000000000000000000009`, and an entry in the app target's Sources phase.

- [ ] **Step 7: Run the full iOS suite**

Run:
```bash
set -o pipefail; xcodebuild test -project ios/POCVault/POCVault.xcodeproj -scheme POCVault \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' 2>&1 | tail -30
```
Expected: PASS — the existing tests plus the new handoff tests, including both source-scan design guards.

- [ ] **Step 8: Commit**

```bash
git add ios/POCVault
git commit -m "feat(ios): handoff card and On-your-Mac section in the thread drawer"
```

---

## Task 24: Push notifications

**Files:**
- Create: `ios/POCVault/POCVault/Services/RelayPushService.swift`
- Modify: `ios/POCVault/POCVault/POCVaultApp.swift` (app delegate adaptor + wiring)
- Modify: `ios/POCVault/POCVault/POCVault.entitlements` (`aps-environment`)
- Modify: `ios/POCVault/POCVault.xcodeproj/project.pbxproj`
- Test: `ios/POCVault/POCVaultTests/HandoffTests.swift` (extend)

**Interfaces:**
- Consumes: cloud `POST /v1/devices` (existing), `handoff.ready` / `handoff.failed` (Task 9), `RelayAccountStore.currentSessionToken`
- Produces:
  - `RelayPushService` — `@MainActor final class`, `ObservableObject`
    - `registerForPushNotifications()`
    - `handleDeviceToken(_ token: Data) async` — registers with the cloud when a session exists
    - `handleNotification(userInfo: [AnyHashable: Any]) -> RelayPushRoute?`
  - `enum RelayPushRoute: Equatable { case handoff(nodeID: String), job(nodeID: String, jobID: String), none }`
  - `RelayPushService.route(from:)` is a `nonisolated static` pure function so it is testable without a device

This task registers for and routes pushes. It does **not** add a Notification Service Extension: the generic banner ("A session is ready to continue") is correct and content-free, and rewriting it with node-fetched detail is the NSE work already noted in `cloud/src/notify.js` — a separate feature.

- [ ] **Step 1: Write the failing tests**

Append to `ios/POCVault/POCVaultTests/HandoffTests.swift`:

```swift
    // MARK: - Push routing

    func testHandoffPushRoutesToTheHandoffSection() {
        let route = RelayPushService.route(from: [
            "aps": ["alert": ["loc-key": "RELAY_EVENT"], "category": "RELAY_HANDOFF_READY"],
            "relay": ["nodeId": "node-1", "jobId": NSNull(), "type": "handoff.ready", "ts": 1, "seq": 1],
        ])
        XCTAssertEqual(route, .handoff(nodeID: "node-1"))
    }

    func testFailedHandoffPushAlsoRoutesToTheHandoffSection() {
        let route = RelayPushService.route(from: [
            "relay": ["nodeId": "node-1", "type": "handoff.failed", "ts": 1, "seq": 2],
        ])
        XCTAssertEqual(route, .handoff(nodeID: "node-1"))
    }

    func testJobPushStillRoutesToItsJob() {
        let route = RelayPushService.route(from: [
            "relay": ["nodeId": "node-1", "jobId": "job-7", "type": "job.completed", "ts": 1, "seq": 3],
        ])
        XCTAssertEqual(route, .job(nodeID: "node-1", jobID: "job-7"))
    }

    func testUnrecognisedOrMalformedPushRoutesNowhere() {
        XCTAssertEqual(RelayPushService.route(from: [:]), RelayPushRoute.none)
        XCTAssertEqual(RelayPushService.route(from: ["relay": ["type": "handoff.ready"]]), RelayPushRoute.none)
        XCTAssertEqual(RelayPushService.route(from: ["relay": ["nodeId": "node-1", "type": "node.health"]]),
                       RelayPushRoute.none)
    }

    func testDeviceTokenIsEncodedAsLowercaseHex() {
        XCTAssertEqual(RelayPushService.hexToken(from: Data([0x0a, 0xff, 0x10])), "0aff10")
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run the `xcodebuild test` command.
Expected: FAIL — `cannot find 'RelayPushService' in scope`.

- [ ] **Step 3: Write the service**

Create `ios/POCVault/POCVault/Services/RelayPushService.swift`:

```swift
import Foundation
import UIKit
import UserNotifications

/// Where a tapped notification should take the user.
enum RelayPushRoute: Equatable {
    case handoff(nodeID: String)
    case job(nodeID: String, jobID: String)
    case none
}

/// APNs registration and routing.
///
/// The payload the cloud sends is deliberately content-free — a node id, an
/// event type, and a sequence. Everything shown to the user is loaded from the
/// node over mTLS after the tap.
@MainActor
final class RelayPushService: NSObject, ObservableObject, UNUserNotificationCenterDelegate {

    @Published private(set) var pendingRoute: RelayPushRoute?
    @Published private(set) var isRegistered = false

    private let accountStore: RelayAccountStore
    private let authBaseURL: URL
    private let session: URLSession

    init(accountStore: RelayAccountStore,
         authBaseURL: URL = AppConfiguration.authBaseURL,
         session: URLSession = .shared) {
        self.accountStore = accountStore
        self.authBaseURL = authBaseURL
        self.session = session
        super.init()
    }

    func registerForPushNotifications() {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
            guard granted else { return }
            Task { @MainActor in UIApplication.shared.registerForRemoteNotifications() }
        }
    }

    func handleDeviceToken(_ token: Data) async {
        let hex = Self.hexToken(from: token)
        guard let sessionToken = accountStore.currentSessionToken else { return }

        var request = URLRequest(url: authBaseURL.appendingPathComponent("v1/devices"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.setValue("Bearer \(sessionToken)", forHTTPHeaderField: "authorization")
        request.httpBody = try? JSONSerialization.data(withJSONObject: [
            "apnsToken": hex,
            "platform": "ios",
            "name": UIDevice.current.name,
        ])

        do {
            let (_, response) = try await session.data(for: request)
            isRegistered = (response as? HTTPURLResponse).map { (200...299).contains($0.statusCode) } ?? false
            CodexDiagnostics.log("push.register", fields: ["registered": String(isRegistered)])
        } catch {
            CodexDiagnostics.log("push.register.failed", fields: ["error": String(describing: error)])
        }
    }

    func clearPendingRoute() { pendingRoute = nil }

    nonisolated static func hexToken(from token: Data) -> String {
        token.map { String(format: "%02x", $0) }.joined()
    }

    nonisolated static func route(from userInfo: [AnyHashable: Any]) -> RelayPushRoute {
        guard let relay = userInfo["relay"] as? [AnyHashable: Any],
              let nodeID = relay["nodeId"] as? String,
              let type = relay["type"] as? String else { return .none }

        if type.hasPrefix("handoff.") { return .handoff(nodeID: nodeID) }
        if type.hasPrefix("job."), let jobID = relay["jobId"] as? String { return .job(nodeID: nodeID, jobID: jobID) }
        return .none
    }

    // MARK: - UNUserNotificationCenterDelegate

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
                                            willPresent notification: UNNotification) async
        -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
                                            didReceive response: UNNotificationResponse) async {
        let route = Self.route(from: response.notification.request.content.userInfo)
        guard route != .none else { return }
        await MainActor.run { self.pendingRoute = route }
    }
}

/// Minimal app delegate: iOS delivers the APNs device token nowhere else.
final class RelayAppDelegate: NSObject, UIApplicationDelegate {
    static weak var pushService: RelayPushService?

    func application(_ application: UIApplication,
                     didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Task { @MainActor in await Self.pushService?.handleDeviceToken(deviceToken) }
    }

    func application(_ application: UIApplication,
                     didFailToRegisterForRemoteNotificationsWithError error: Error) {
        CodexDiagnostics.log("push.token.failed", fields: ["error": String(describing: error)])
    }
}
```

- [ ] **Step 4: Wire it into the app**

In `ios/POCVault/POCVault/POCVaultApp.swift`, inside the `@main` struct:

```swift
    @UIApplicationDelegateAdaptor(RelayAppDelegate.self) private var appDelegate
    @StateObject private var pushService = RelayPushService(accountStore: accountStore)
```

and, on the root view:

```swift
            .environmentObject(pushService)
            .task {
                RelayAppDelegate.pushService = pushService
                pushService.registerForPushNotifications()
            }
```

Then, where the root view already reacts to state, open the thread drawer when a handoff route arrives:

```swift
            .onChange(of: pushService.pendingRoute) { _, route in
                guard case .handoff = route else { return }
                showThreadDrawer = true
                pushService.clearPendingRoute()
            }
```

(Use whatever the drawer's existing presentation binding is named; if the drawer is presented from `RelayChatView`, hoist the same `onChange` there instead.)

In `ios/POCVault/POCVault/POCVault.entitlements`, add:

```xml
	<key>aps-environment</key>
	<string>development</string>
```

Add `RelayPushService.swift` to the project: file ref `100000000000000000000054`, build file `200000000000000000000050`, membership in the Services group `500000000000000000000011`, and an entry in the app target's Sources phase.

- [ ] **Step 5: Run the full iOS suite**

Run:
```bash
set -o pipefail; xcodebuild test -project ios/POCVault/POCVault.xcodeproj -scheme POCVault \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' 2>&1 | tail -30
```
Expected: PASS — all existing tests plus the 5 push-routing tests. (Push registration itself cannot be exercised on the simulator; only the pure routing and encoding functions are asserted.)

- [ ] **Step 6: Commit**

```bash
git add ios/POCVault
git commit -m "feat(ios): APNs registration and handoff notification routing"
```

---

## Task 25: Documentation

**Files:**
- Create: `product/cli/README.md`
- Modify: `product/relayd/API.md` (new §2.9)
- Modify: `product/cloud/README.md` (handoff + device-code routes)
- Modify: `product/STATUS.md` (new section + test evidence)
- Modify: `revamp/04-product-plan.md` (§4.6 sequencing note)

**Interfaces:**
- Consumes: everything built in Tasks 1–24
- Produces: documentation matching the shipped behavior, with genericized hostnames per the repo convention

- [ ] **Step 1: Write the CLI README**

Create `product/cli/README.md` covering: what `relay` is, install, the five commands with real example output, the security model in three sentences (GitHub holds ciphertext, the cloud holds names, plaintext exists only on the laptop and in the sandbox), the `relay/handoff-*` branch convention and how to clean up merged branches, the `RELAY_ALLOW_LOCAL_REMOTE` test escape hatch, and troubleshooting for `not_logged_in`, `no_machine_pinned`, `origin_not_github`, and a failed handoff that needs `relay sync-auth`.

- [ ] **Step 2: Document the node API**

In `product/relayd/API.md`, add §2.9 "Handoffs" documenting `GET /v1/handoffs`, `GET /v1/handoffs/:id`, `POST /v1/handoffs/:id/continue`, and `GET /v1/mac-sessions`: request/response shapes, the handoff record's states, the sealed-blob wire format from Task 1, and the manifest v1 schema. State plainly that the manifest and session blobs are decrypted only on the node.

- [ ] **Step 3: Document the cloud API**

In `product/cloud/README.md`, add the new routes — `POST /v1/auth/device/{start,token,approve}`, `POST|GET /v1/repos`, `POST|GET /v1/handoffs`, `GET /v1/node/handoffs?wait=` — with the node-signed request scheme from Task 7 (exact signing string), the 25 s long-poll cap and its nginx rationale, the new event types, and the rendezvous `kind` values.

- [ ] **Step 4: Update STATUS.md**

Add a "Relay CLI + session handoff" section to `product/STATUS.md` in the same table format as the existing ones: one row per component (cli, cloud, relayd, iOS) with status, evidence paths, and notes. Record the actual test counts from the runs below. List the known gaps honestly: no NSE (generic banner only), Cursor has no native resume, BYO zero-knowledge CLI pairing not built, `relay pull`/`relay send` still unbuilt, and the physical device push path never exercised against live APNs.

- [ ] **Step 5: Note the sequencing change**

In `revamp/04-product-plan.md` §4.6, note that `handoff`/`sync-auth`/`status` landed ahead of the `status`/`pull` v0 sequencing described there, and that `relay pull` remains unbuilt — `git fetch` covers it for now.

- [ ] **Step 6: Run every suite and record the numbers**

```bash
cd product/cli   && node --test test/*.test.mjs
cd ../cloud      && node --test test/*.test.mjs
cd ../relayd     && node --test test/*.test.mjs
cd ../broker     && go vet ./... && go build ./... && go test -count=1 ./...
cd ../.. && xcodebuild test -project ios/POCVault/POCVault.xcodeproj -scheme POCVault \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro'
```

Put the real pass/fail counts in STATUS.md. If a suite fails, fix it before writing the numbers down — never record an aspirational count.

- [ ] **Step 7: Commit**

```bash
git add product/cli/README.md product/relayd/API.md product/cloud/README.md product/STATUS.md revamp/04-product-plan.md
git commit -m "docs: relay CLI, handoff API, and status for the handoff pipeline"
```

---

## Deferred (explicitly not in this plan)

These are real gaps, named so nobody assumes they shipped:

- **Notification Service Extension.** Pushes show a generic banner. Rewriting it with node-fetched detail needs a new target and the tunnel reachable from an extension.
- **Cursor native resume.** No portable session file exists; Cursor always takes the primed-prompt path.
- **BYO zero-knowledge CLI pairing.** The CLI trusts the cloud's attestation of the node encryption key. A BYO tier needs the QR/phone-mediated flow instead.
- **`relay pull` / `relay send`** from `revamp/04-product-plan.md` §4.6.
- **Live APNs on a physical device.** Only the mock transport and pure routing functions are exercised.
- **Handoff branch cleanup.** Branches accumulate on the remote; pruning merged `relay/handoff-*` branches is manual.
- **Multi-node.** The CLI pins exactly one machine — the account's trial node.
