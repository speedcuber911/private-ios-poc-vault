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

// Canonical node-key fingerprint: SHA-256 over the 32 *decoded* key bytes
// (never over the base64 text), first 16 hex characters. This is the
// representation both the CLI and the cloud can agree on — the cloud stores
// whatever base64 the enrolling node submitted verbatim and never
// re-canonicalizes it, so hashing the wire string would make the fingerprint
// depend on incidental base64 formatting (padding, alphabet). The iOS side
// (a later, deferred task) must decode-then-hash exactly this way to match.
function fingerprint(encPubkeyB64) {
  return crypto.createHash("sha256").update(Buffer.from(String(encPubkeyB64), "base64")).digest("hex").slice(0, 16);
}

async function cmdLogin(args = [], deps = {}) {
  const {
    home = undefined,
    baseUrl = DEFAULT_BASE_URL,
    fetchImpl = fetch,
    openBrowser = defaultOpenBrowser,
    log = console.log,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = () => Date.now(),
  } = deps;

  const anonymous = createCloudApi({ baseUrl, fetchImpl });
  const start = await anonymous.startDeviceLogin();
  if (start.status !== 201) throw new Error(`login_start_failed_${start.status}`);

  const { deviceCode, userCode, verificationUri, interval, expiresIn } = start.json;
  log("");
  log(`  Your code:  ${userCode}`);
  log(`  Approve at: ${verificationUri}`);
  log("");
  log("  Waiting for approval…");
  openBrowser(verificationUri);

  // A server bug or a network partition that keeps answering
  // authorization_pending must not hang this command forever — track our own
  // deadline from the budget the server handed us at start time, and give up
  // once it passes regardless of what subsequent polls say. If the server
  // didn't send a usable expiresIn, don't impose an invented ceiling.
  const expiresInSeconds = Number(expiresIn);
  const deadline = Number.isFinite(expiresInSeconds) && expiresInSeconds > 0
    ? now() + expiresInSeconds * 1000
    : Infinity;
  // The server-supplied interval is untrusted in both directions: Node
  // clamps a negative setTimeout delay to 0, so a hostile or buggy negative
  // `interval` could otherwise drive this into a hot loop against the auth
  // server — floor it at 1s. Symmetrically, Node's setTimeout silently
  // clamps any delay above 2147483647ms (~24.8 days) to 1ms, so a huge or
  // Infinity `interval` would reproduce that exact same hot loop via the
  // opposite extreme — cap it at a sane maximum well under that ceiling.
  const MAX_POLL_INTERVAL_SECONDS = 300;
  const intervalMs = Math.min(MAX_POLL_INTERVAL_SECONDS, Math.max(1, Number(interval) || 5)) * 1000;

  let session = null;
  for (;;) {
    await sleep(intervalMs);
    if (now() >= deadline) throw new Error("login_expired: the code timed out — run relay login again");
    const poll = await anonymous.pollDeviceToken(deviceCode);
    if (poll.status === 200) {
      if (!poll.json || typeof poll.json.sessionToken !== "string") {
        throw new Error("login_failed_bad_response: the server returned an unexpected response");
      }
      session = poll.json;
      break;
    }
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
