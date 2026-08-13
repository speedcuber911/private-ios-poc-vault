// relay login — device-code sign-in via QR (or typed code), then pin the
// sandbox this machine hands off to. The session token and device code are
// never printed; only the user code (which is meant to be read aloud) and the
// key fingerprint are.
import crypto from "node:crypto";
import os from "node:os";

import { createCloudApi, DEFAULT_BASE_URL } from "../cloud.mjs";
import { readCredentials, writeCredentials } from "../creds.mjs";
import { noopProgress } from "../progress.mjs";
import { renderQrAnsi, qrAnsiWidth } from "../qr.mjs";

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

function normalizePlatform(platform = process.platform) {
  if (platform === "darwin") return "macos";
  if (platform === "linux") return "linux";
  if (platform === "win32") return "windows";
  return "other";
}

async function cmdLogin(args = [], deps = {}) {
  const {
    home = undefined,
    baseUrl = DEFAULT_BASE_URL,
    fetchImpl = fetch,
    log = console.log,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = () => Date.now(),
    hostname = () => os.hostname(),
    platform = process.platform,
    stdout = process.stdout,
    progress = noopProgress,
  } = deps;

  const noQr = args.includes("--no-qr");
  const anonymous = createCloudApi({ baseUrl, fetchImpl });
  const start = await progress.run("Requesting a login code", () => anonymous.startDeviceLogin({
    machineName: hostname(),
    platform: normalizePlatform(platform),
  }));
  if (start.status !== 201) throw new Error(`login_start_failed_${start.status}`);

  const {
    deviceCode,
    userCode,
    verificationUri,
    verificationUriComplete,
    interval,
    expiresIn,
  } = start.json;

  const qrPayload = verificationUriComplete
    || (verificationUri ? `${verificationUri}#code=${userCode}` : null);

  log("");
  // QR above the human code. Skip when asked, when stdout isn't a TTY, or
  // when the terminal is narrower than the rendered symbol (wrapping breaks
  // finder patterns and cameras can't lock).
  const columns = stdout.columns;
  const canFit = columns == null || columns >= (qrPayload ? qrAnsiWidth(qrPayload) : Infinity);
  if (!noQr && stdout.isTTY && qrPayload && canFit) {
    log(renderQrAnsi(qrPayload));
    log("");
  }
  log(`  Your code:  ${userCode}`);
  log(`  Approve at: ${verificationUri}`);
  log("");
  // A step rather than a static line: this is the longest wait in the CLI, and
  // it is the one place a user genuinely cannot tell "polling" from "hung".
  // Without a TTY it degrades to the exact line this used to print.
  progress.start("Waiting for approval");

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
  // Every exit from this loop except the break is a throw, and bin/relay turns
  // a throw straight into process.exit — so without this finally, a timed-out
  // or rejected login would leave the cursor hidden for the rest of the
  // terminal session.
  try {
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
  } finally {
    progress.stop();
  }

  // A login REPLACES the identity on this machine; it must never merge into
  // the previous one. writeCredentials merges by design, so the pinned machine
  // has to be cleared explicitly right here — passing null drops the field.
  //
  // Without this, approving a code with a DIFFERENT account left that account's
  // session sitting next to the previous account's `nodeId`/`nodeEncPubkey`,
  // because the only thing that overwrote the pin was the trial lookup below —
  // and that returns early when the new account has no machine. Two accounts,
  // one credentials file. Concretely, that mismatch meant:
  //
  //   - `relay handoff` sealed the session blob to the OTHER account's node
  //     public key and pushed it to GitHub before the cloud rejected the row
  //     as `unknown_node`. Content encrypted to someone else's key, published.
  //   - `relay sync-auth` sent THIS machine's GitHub and harness logins to
  //     whatever sandbox was pinned — the wrong account's sandbox.
  //
  // Clearing unconditionally (not just when the account changes) is deliberate:
  // the pin is derived from the account's current trial, so a stale pin is
  // wrong even on a repeat login to the same account whose machine has since
  // been destroyed.
  const previous = readCredentials({ home });
  const switchedAccount = Boolean(previous?.accountId)
    && previous.accountId !== session.accountId;

  writeCredentials({
    sessionToken: session.sessionToken,
    refreshToken: session.refreshToken,
    accountId: session.accountId,
    nodeId: null,
    nodeEncPubkey: null,
  }, { home });

  if (switchedAccount) {
    // Loud, because this is the shape of an accidental account takeover: the
    // QR is on screen, someone else scans it, and this machine is now theirs.
    // The unpin above already stops a handoff or a credential sync going to
    // the wrong sandbox, but the operator still needs to know it happened.
    log("  Signed in — but as a DIFFERENT account than this machine used before.");
    log("  The previously pinned machine has been unpinned.");
    log("  If you did not intend this, run relay login again and approve it yourself:");
    log("  `relay sync-auth` would send this machine's GitHub and harness logins");
    log("  to the newly signed-in account's sandbox.");
  } else {
    log("  Signed in.");
  }

  const authed = createCloudApi({
    baseUrl,
    sessionToken: session.sessionToken,
    refreshToken: session.refreshToken,
    home,
    fetchImpl,
  });
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

export { cmdLogin, fingerprint, normalizePlatform };
