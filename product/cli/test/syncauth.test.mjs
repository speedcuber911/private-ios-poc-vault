import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { cmdSyncAuth, collectCredentialBundle, authTokenFor, macKeyFor, blobTagFor } = await import("../src/commands/syncauth.mjs");
const { writeCredentials } = await import("../src/creds.mjs");
const { generateEncKeyPair, openSealed } = await import("../src/seal.mjs");
const { claudeProjectSlug } = await import("../src/sessions.mjs");

function homeWithCreds(node) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-syncauth-"));
  writeCredentials({ sessionToken: "sess", accountId: "acct", nodeId: "node-1", nodeEncPubkey: node.publicKeyB64 }, { home });
  return home;
}

function recordingCloud({ noticeStatus = 201, noticeBody = { notice: { id: "notice-1", state: "pending" } } } = {}) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, options = {}) => {
      const pathname = new URL(url).pathname;
      calls.push({ pathname, headers: options.headers || {}, raw: options.body, body: typeof options.body === "string" ? JSON.parse(options.body) : null });
      if (pathname === "/v1/pairing/sessions") {
        return { status: 201, json: async () => ({ pairingId: "11111111-1111-4111-8111-111111111111", expiresAt: 1 }) };
      }
      if (pathname === "/v1/sync-auth/notices") {
        return { status: noticeStatus, json: async () => noticeBody };
      }
      return { status: 204, json: async () => null };
    },
  };
}

test("credentials are collected, sealed to the node, and delivered over the rendezvous", async () => {
  // authTokenFor(secret) is base64url of a sha256 digest. The regex below
  // only proves that when the digest's bytes actually need a base64url
  // substitution character (-/_ in place of what standard base64 would spell
  // as +//): a regression to `.digest("base64").replace(/=+$/,"")` is
  // byte-identical to the correct spelling whenever the digest needs neither
  // — measured at 26.383% of secrets — and the cloud hard-rejects the other
  // alphabet (AUTH_TOKEN_RE in product/cloud/src/pairing.js), so this is the
  // only thing standing between a passing suite and every sync-auth call
  // 400ing in production. generateSecret() draws a fresh secret internally
  // on every cmdSyncAuth call and is not injectable, so retry the whole
  // (cheap: no network, no subprocess) flow with a fresh home/node/cloud
  // each time until the token needs a substitution character, and assert
  // the premise so a stuck loop fails loudly instead of silently passing.
  let sessionCall = null;
  let blobCall, bundle, result, lines;
  for (let attempt = 0; attempt < 40; attempt++) {
    const node = generateEncKeyPair();
    const home = homeWithCreds(node);
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(home, ".claude", ".credentials.json"), '{"token":"claude-token"}');
    fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(home, ".codex", "auth.json"), '{"token":"codex-token"}');

    const cloud = recordingCloud();
    lines = [];

    result = await cmdSyncAuth([], {
      home, baseUrl: "https://cloud.test", fetchImpl: cloud.fetchImpl, log: (line) => lines.push(line),
      execFileImpl: async () => ({ stdout: "ghp_from_gh_cli\n" }),
    });

    blobCall = cloud.calls.find((call) => call.pathname.endsWith("/device-blob"));
    bundle = JSON.parse(openSealed(node.privateKeyPem, Buffer.from(blobCall.raw)).toString("utf8"));
    const candidate = cloud.calls.find((call) => call.pathname === "/v1/pairing/sessions");
    // Stop as soon as either the draw is distinguishing (needs -/_, so a
    // regression to std-base64 would visibly differ) OR the token is already
    // visibly wrong (contains +//, failing the shape check outright) — the
    // latter lets a real regression fail immediately and legibly via the
    // assert.match below, instead of spinning to the attempt cap first.
    if (candidate && (/[-_]/.test(candidate.body.authToken) || !/^[A-Za-z0-9_-]{43}$/.test(candidate.body.authToken))) {
      sessionCall = candidate;
      break;
    }
  }
  assert.ok(sessionCall,
    "could not mint an authToken needing a base64url substitution character after 40 attempts — the test premise is broken, not the code under test");

  assert.deepEqual(result.installed.sort(), ["claude", "codex", "github"]);
  assert.equal(bundle.kind, "sync-auth");
  assert.equal(bundle.github.token, "ghp_from_gh_cli");
  assert.equal(bundle.claude.credentials, '{"token":"claude-token"}');

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

// The brief promises "Both `relay sync-auth` and `relay handoff` refresh
// [the session index]", but nothing asserted that cmdSyncAuth's own refresh
// actually runs — it previously only executed by accident, because the
// ambient host checkout this suite happens to run inside has a github.com
// origin. Pin it explicitly via an injected repo lookup, using a throwaway
// repo directory that has nothing to do with whatever repo the suite is
// invoked from, so the assertion holds in any environment (CI, a tarball
// checkout, a detached worktree with no github origin, etc).
test("cmdSyncAuth refreshes the session index through an injected repo lookup, independent of the host repo", async () => {
  // Same 26.4%-vacuous alphabet issue as the test above, for the
  // session-index publish's own independently-generated secret. Retry the
  // whole (cheap: no network, no subprocess) flow with a fresh
  // home/repo/cloud each time until this specific token needs a base64url
  // substitution character, and assert the premise rather than hoping for it.
  let sessionIndexCall = null;
  let cloud, lines, result, repoLookupCalledWith;
  for (let attempt = 0; attempt < 40; attempt++) {
    const node = generateEncKeyPair();
    const home = homeWithCreds(node);
    const repoRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-syncauth-repo-")));
    // discoverClaudeSessions (src/sessions.mjs) only offers a transcript whose
    // id matches RESUMABLE_SESSION_ID_RE and whose own records declare the
    // matching cwd — a bare "s1.jsonl" with no `cwd` field satisfies neither,
    // so discoverSessions would find nothing and the retry below would spin
    // forever without ever seeing "Shared 1 local session".
    const sessionFile = path.join(
      home, ".claude", "projects", claudeProjectSlug(repoRoot), "11111111-1111-1111-1111-111111111111.jsonl");
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, `${JSON.stringify({ type: "user", cwd: repoRoot, message: { content: "fix the auth bug" } })}\n`);

    cloud = recordingCloud();
    lines = [];
    repoLookupCalledWith = null;

    result = await cmdSyncAuth([], {
      home, baseUrl: "https://cloud.test", fetchImpl: cloud.fetchImpl, log: (line) => lines.push(line),
      execFileImpl: async () => { throw new Error("no gh"); },
      requireGitHubRepoImpl: async (opts) => {
        repoLookupCalledWith = opts;
        return { root: repoRoot, fullName: "acme/relay" };
      },
    });

    const candidate = cloud.calls.find((call) => call.pathname === "/v1/pairing/sessions" && call.body?.kind === "session-index");
    // Same early-stop-on-visible-regression reasoning as the test above.
    if (candidate && (/[-_]/.test(candidate.body.authToken) || !/^[A-Za-z0-9_-]{43}$/.test(candidate.body.authToken))) {
      sessionIndexCall = candidate;
      break;
    }
  }
  assert.ok(sessionIndexCall,
    "could not mint a session-index authToken needing a base64url substitution character after 40 attempts — the test premise is broken, not the code under test");

  assert.ok(repoLookupCalledWith, "cmdSyncAuth must consult the injected repo lookup, not skip straight to the catch");
  assert.match(sessionIndexCall.body.authToken, /^[A-Za-z0-9_-]{43}$/, "the rendezvous sees a derived token, not the secret, for the session-index publish too");

  const deviceBlobCalls = cloud.calls.filter((call) => call.pathname.endsWith("/device-blob"));
  assert.equal(deviceBlobCalls.length, 2, "one sealed blob for sync-auth, one for the session index");

  assert.match(lines.join("\n"), /Shared 1 local session/, "the refresh's own session count must be reported");
  assert.deepEqual(result.installed, [], "unrelated to whether any credential was installed");
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

// Not reachable through the real execFileAsync (Node's promisified execFile
// always resolves { stdout, stderr } with both keys present on a clean
// exit), but a credential-shaped string that is not a credential is exactly
// the kind of thing that ends up written to disk and silently failing
// later, so a malformed execFileImpl must never fabricate one.
test("collectCredentialBundle never fabricates a token from a malformed execFileImpl result", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-bundle-malformed-"));

  const { bundle, skipped } = await collectCredentialBundle({ home, execFileImpl: async () => ({}) });

  assert.equal(bundle.github, undefined, "a missing stdout must never be coerced into the literal string 'undefined'");
  assert.ok(skipped.includes("github"));
});

// ---------------------------------------------------------------------------
// Announcing the slot. Sealing a bundle into a rendezvous is only half a
// sync: nothing on the node can discover a pending pairing session, so
// without this notice the credentials sit in a slot nobody ever reads and
// expire 15 minutes later — a sync that reported success and did nothing.

function noticeCalls(cloud) {
  return cloud.calls.filter((call) => call.pathname === "/v1/sync-auth/notices");
}

test("the machine is told where to collect: a notice names the pairing id, the node and the secret", async () => {
  const node = generateEncKeyPair();
  const home = homeWithCreds(node);
  const cloud = recordingCloud();
  const lines = [];

  await cmdSyncAuth([], {
    home, baseUrl: "https://cloud.test", fetchImpl: cloud.fetchImpl, log: (line) => lines.push(line),
    execFileImpl: async () => ({ stdout: "ghp_notice_token\n" }),
    requireGitHubRepoImpl: async () => { throw new Error("not a repo"); },
  });

  const notices = noticeCalls(cloud);
  assert.equal(notices.length, 1, "the credential bundle must be announced exactly once");
  assert.equal(notices[0].body.nodeId, "node-1", "the notice names the pinned machine");

  const sessionCall = cloud.calls.find((call) => call.pathname === "/v1/pairing/sessions");
  const blobCall = cloud.calls.find((call) => call.pathname.endsWith("/device-blob"));
  assert.equal(notices[0].body.pairingId, "11111111-1111-4111-8111-111111111111");

  // The secret in the notice must be the one that actually opens the slot and
  // authenticates the blob — not a fresh one, and not the derived token.
  assert.equal(authTokenFor(notices[0].body.secret), sessionCall.body.authToken,
    "the announced secret must derive the auth token the rendezvous was created with");
  assert.equal(blobTagFor(macKeyFor(notices[0].body.secret), "device-blob", Buffer.from(blobCall.raw)),
    blobCall.headers["x-pairing-tag"],
    "the announced secret must derive the MAC key the blob was tagged with");
  assert.notEqual(notices[0].body.secret, sessionCall.body.authToken,
    "the notice carries the secret, not the token derived from it");

  // The notice rides the session bearer, like every other CLI call.
  assert.match(String(notices[0].headers.authorization || ""), /^Bearer /);

  // And none of it is ever printed.
  const printed = lines.join("\n");
  assert.ok(!printed.includes(notices[0].body.secret), "the rendezvous secret is never printed");
  assert.ok(!printed.includes("ghp_notice_token"), "no credential is ever printed");
});

test("the session index is announced too, or the phone would never see it", async () => {
  const node = generateEncKeyPair();
  const home = homeWithCreds(node);
  const repoRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-syncauth-notice-repo-")));
  const sessionFile = path.join(home, ".claude", "projects", claudeProjectSlug(repoRoot), "s1.jsonl");
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  fs.writeFileSync(sessionFile, `${JSON.stringify({ type: "user", message: { content: "fix the auth bug" } })}\n`);

  const cloud = recordingCloud();
  await cmdSyncAuth([], {
    home, baseUrl: "https://cloud.test", fetchImpl: cloud.fetchImpl, log: () => {},
    execFileImpl: async () => { throw new Error("no gh"); },
    requireGitHubRepoImpl: async () => ({ root: repoRoot, fullName: "acme/relay" }),
  });

  const notices = noticeCalls(cloud);
  assert.equal(notices.length, 2, "one notice for the credential bundle, one for the session index");
  assert.deepEqual(notices.map((call) => call.body.nodeId), ["node-1", "node-1"],
    "both notices must name the machine — the cloud refuses one that does not, and the index would never arrive");
  assert.notEqual(notices[0].body.secret, notices[1].body.secret,
    "each rendezvous originates its own secret");
});

// The whole point of this feature is that a sync which quietly did nothing is
// worse than one that failed: the user walks away believing their sandbox is
// authenticated. A notice the cloud refuses must therefore end the command
// loudly, not be swallowed like the best-effort session-index refresh.
test("a notice the cloud refuses fails the command instead of reporting a sync that never lands", async () => {
  const node = generateEncKeyPair();
  const home = homeWithCreds(node);
  const cloud = recordingCloud({ noticeStatus: 503 });
  const lines = [];

  await assert.rejects(
    () => cmdSyncAuth([], {
      home, baseUrl: "https://cloud.test", fetchImpl: cloud.fetchImpl, log: (line) => lines.push(line),
      execFileImpl: async () => ({ stdout: "ghp_never_announced\n" }),
      requireGitHubRepoImpl: async () => { throw new Error("not a repo"); },
    }),
    (error) => {
      assert.match(error.message, /sync_notice_failed_503/);
      assert.match(error.message, /relay sync-auth/, "the error must tell the user what to do next");
      assert.ok(!error.message.includes("ghp_never_announced"), "an error must never carry a credential");
      return true;
    },
  );

  assert.ok(!lines.join("\n").includes("Sent github login"),
    "nothing may claim a credential reached the machine when the machine was never told");
});

// A stale/deleted/foreign node pin yields 404 unknown_node. Re-running
// sync-auth cannot fix that — the pin itself is wrong — so the error must
// point at `relay login`, not loop the user back into sync-auth.
test("a notice the cloud refuses fails the command instead of reporting a sync that never lands — unknown_node points at re-pin", async () => {
  const node = generateEncKeyPair();
  const home = homeWithCreds(node);
  const cloud = recordingCloud({ noticeStatus: 404, noticeBody: { error: "unknown_node" } });
  const lines = [];

  await assert.rejects(
    () => cmdSyncAuth([], {
      home, baseUrl: "https://cloud.test", fetchImpl: cloud.fetchImpl, log: (line) => lines.push(line),
      execFileImpl: async () => ({ stdout: "ghp_never_announced\n" }),
      requireGitHubRepoImpl: async () => { throw new Error("not a repo"); },
    }),
    (error) => {
      assert.match(error.message, /sync_notice_failed_404/);
      assert.match(error.message, /relay login/);
      assert.match(error.message, /re-pin/);
      assert.ok(!error.message.includes("ghp_never_announced"), "an error must never carry a credential");
      return true;
    },
  );

  assert.ok(!lines.join("\n").includes("Sent github login"),
    "nothing may claim a credential reached the machine when the machine was never told");
});

test("a session without a pinned machine refuses before any credential is collected", async () => {
  // Both halves of the pin are required now: the key to seal TO, and the node
  // id to announce the slot to. A credentials file holding only one of them
  // (an interrupted `relay login`, or one that ran before the machine
  // existed) must refuse rather than seal a bundle nothing will ever collect.
  const cases = [
    ["neither", {}],
    ["a key but no machine id", { nodeEncPubkey: generateEncKeyPair().publicKeyB64 }],
    ["a machine id but no key", { nodeId: "node-1" }],
  ];
  for (const [label, pinned] of cases) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-syncauth-nomachine-"));
    writeCredentials({ sessionToken: "sess", accountId: "acct", ...pinned }, { home });
    const cloud = recordingCloud();

    await assert.rejects(
      () => cmdSyncAuth([], {
        home, baseUrl: "https://cloud.test", fetchImpl: cloud.fetchImpl, log: () => {},
        execFileImpl: async () => ({ stdout: "ghp_should_never_be_collected\n" }),
      }),
      /no_machine_pinned/,
      `${label}: must refuse`,
    );
    assert.equal(cloud.calls.length, 0, "nothing may be sent anywhere without a machine to send it to");
  }
});
