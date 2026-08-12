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
  const api = createCloudApi({
    baseUrl,
    sessionToken: credentials.sessionToken,
    refreshToken: credentials.refreshToken,
    home,
    fetchImpl,
  });
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
