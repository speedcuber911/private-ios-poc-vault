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
