// relayd version.mjs — the node's build identity: which version this process
// is running, which commit it was built from, and when.
//
// Three hard constraints, all of them consequences of WHERE this is read. The
// /healthz payload is answered before authorize() and must not be able to
// fail; `relayd status` runs in a short-lived process that should not pay for
// a subprocess; and update.mjs compares this value against an announced
// release before it will download anything. So this module is SYNCHRONOUS, it
// makes no network call and spawns no child, it never throws, and `version` is
// never the empty string — a node that cannot name its own version is
// invisible to the fleet, which is the exact problem the 2026-09-21
// release-subscription spec exists to close.
//
// Where the answer comes from, in order:
//
//   1. `<appDir>/build-info.json`, written by the packaging step. `appDir` is
//      the parent of src/ — `product/relayd/` in this checkout, and
//      `/opt/relayd/releases/<version>/` on a node installed by
//      dist/install.sh. The file is NOT in the repository: it is generated at
//      package time, which is the whole point (package.json's `version` has
//      said 0.1.0 since the beginning and is not derived from anything).
//      Shape, all three fields required, unknown keys ignored:
//
//          { "version": "0.2.0", "commit": "<sha>", "builtAt": "<iso8601>" }
//
//      RELAYD_BUILD_INFO_FILE overrides the path. That override is what lets a
//      test — and update.mjs's own post-flip health check — stand a known
//      build identity up without packaging anything.
//   2. `<appDir>/package.json`'s `version`, plus the git SHA when this happens
//      to be a working checkout.
//   3. UNKNOWN_VERSION, chosen so that it still PARSES and still compares as
//      older than any real release (see update.mjs's parseVersion): a node
//      that fell all the way through here can still be rescued by an
//      announcement instead of being frozen out of updates.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// A prerelease tail, deliberately: update.mjs orders prereleases BEFORE the
// release they qualify, so this sorts below 0.0.0 and below everything else.
const UNKNOWN_VERSION = "0.0.0-unknown";

const BUILD_INFO_FILENAME = "build-info.json";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const defaultAppDir = path.dirname(moduleDir);

// How far up from the app directory to look for a `.git`. A checkout of this
// repository puts product/relayd two levels down; the bound exists so a
// packaged install under / does not walk the whole filesystem to learn that it
// has no git metadata.
const GIT_SEARCH_DEPTH = 6;

function readJsonOrNull(file) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
}

// Bounded and single-line. This string ends up in a heartbeat body, an audit
// line, a health payload and a filesystem path (`releases/<version>`), so a
// value with a slash, a newline or a NUL in it is not merely ugly.
function cleanVersion(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > 64) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9.+_-]*$/.test(text)) return null;
  return text;
}

function cleanCommit(value) {
  if (typeof value !== "string") return null;
  const text = value.trim().toLowerCase();
  return /^[0-9a-f]{7,64}$/.test(text) ? text : null;
}

function cleanTimestamp(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > 64) return null;
  return Number.isNaN(Date.parse(text)) ? null : text;
}

// The directory git keeps its metadata in, or null. `.git` is normally a
// directory; in a linked worktree it is a FILE containing `gitdir: <path>`,
// which is how this repository's own best-of-n worktrees appear.
function resolveGitDir(startDir) {
  let dir = startDir;
  for (let depth = 0; depth <= GIT_SEARCH_DEPTH; depth++) {
    const candidate = path.join(dir, ".git");
    try {
      const stat = fs.statSync(candidate);
      if (stat.isDirectory()) return candidate;
      if (stat.isFile()) {
        const match = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(candidate, "utf8"));
        if (match) return path.resolve(dir, match[1].trim());
      }
    } catch {
      // Not here (or not readable) — keep walking up.
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// The SHA of a working checkout, read the way git itself stores it rather than
// by shelling out to `git rev-parse`: spawning a child process in a
// synchronous module-level initializer is precisely the cost this file
// promises not to pay, and a packaged install may have no git binary and no
// .git at all — where null is the honest answer, not an error.
function gitHeadCommit(startDir) {
  const gitDir = resolveGitDir(startDir);
  if (!gitDir) return null;
  let head;
  try {
    head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
  } catch {
    return null;
  }
  const ref = /^ref:\s*(.+)$/.exec(head);
  if (!ref) return cleanCommit(head);
  const refName = ref[1].trim();
  try {
    return cleanCommit(fs.readFileSync(path.join(gitDir, refName), "utf8"));
  } catch {
    // A ref that has been packed has no loose file; packed-refs is the index.
  }
  try {
    const packed = fs.readFileSync(path.join(gitDir, "packed-refs"), "utf8");
    const line = new RegExp(`^([0-9a-f]{40,64})\\s+${refName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m").exec(packed);
    return line ? cleanCommit(line[1]) : null;
  } catch {
    return null;
  }
}

// Exported so tests (and `relayd update`, which reads the identity of a
// STAGED tree rather than of the running one) can ask the same question about
// a different directory. Same contract as the module-level constants: sync, no
// network, no throw, non-empty `version`.
function readBuildIdentity({ appDir = null, buildInfoFile = null } = {}) {
  // RELAYD_BUILD_INFO_FILE names the identity of THIS process, so it applies
  // only to the default app directory. Asked about a staged tree, this
  // function must answer about that tree — otherwise the engine would read
  // the running node's own version back out of the candidate it is about to
  // install, and every artifact would appear to carry the right version.
  const root = appDir || defaultAppDir;
  const infoPath =
    buildInfoFile ||
    (appDir ? path.join(appDir, BUILD_INFO_FILENAME) : process.env.RELAYD_BUILD_INFO_FILE || path.join(root, BUILD_INFO_FILENAME));
  const info = readJsonOrNull(infoPath);
  const packaged = info ? cleanVersion(info.version) : null;
  if (packaged) {
    return {
      version: packaged,
      commit: cleanCommit(info.commit),
      builtAt: cleanTimestamp(info.builtAt),
      source: "build-info",
    };
  }

  const manifest = readJsonOrNull(path.join(root, "package.json"));
  const declared = manifest ? cleanVersion(manifest.version) : null;
  if (declared) {
    return { version: declared, commit: gitHeadCommit(root), builtAt: null, source: "package.json" };
  }

  return { version: UNKNOWN_VERSION, commit: null, builtAt: null, source: "unknown" };
}

const identity = readBuildIdentity();

const version = identity.version;
const commit = identity.commit;
const builtAt = identity.builtAt;

// The path consulted for (1) above, so `relayd doctor`/`status` and the
// packaging step can name it without re-deriving the rule.
const buildInfoPath = process.env.RELAYD_BUILD_INFO_FILE || path.join(defaultAppDir, BUILD_INFO_FILENAME);

export {
  version,
  commit,
  builtAt,
  buildInfoPath,
  readBuildIdentity,
  cleanVersion,
  UNKNOWN_VERSION,
  BUILD_INFO_FILENAME,
};
