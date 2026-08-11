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
