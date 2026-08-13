// relay handoff — the shut-the-laptop moment.
//
// The branch carries the work; two blobs sealed to the node's key carry the
// manifest and the transcript. GitHub therefore stores ciphertext for anything
// conversational, and the control plane is told only names.
//
// The handoff commit is built entirely with plumbing against a throwaway
// index file (GIT_INDEX_FILE) — read-tree, add, hash-object, write-tree,
// commit-tree, update-ref. The user's real working tree, real index, and HEAD
// are never written to, so there is nothing to restore: the checkout the user
// left before running this command is the checkout they are in when it
// returns, because it was never touched in the first place.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { createCloudApi, DEFAULT_BASE_URL } from "../cloud.mjs";
import { noopProgress } from "../progress.mjs";
import { readCredentials } from "../creds.mjs";
import { requireGitHubRepo, workingTreeSummary, git } from "../repo.mjs";
import { discoverSessions, readSessionBytes, sessionExcerpt } from "../sessions.mjs";
import { sealTo } from "../seal.mjs";

const execFileAsync = promisify(execFile);
const MAX_SESSION_BYTES = 20 * 1024 * 1024;
const BLOB_PATH_PREFIX = ".relay/handoff";

function flagValue(args, name) {
  const index = args.findIndex((arg) => arg === name || arg.startsWith(`${name}=`));
  if (index === -1) return null;
  const arg = args[index];
  return arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : args[index + 1] || null;
}

// Opaque by design: relay/handoff-<handoff id, first 12 hex chars>. The
// branch used to be relay/handoff-<slug of the user's first prompt>-<id>,
// which published prompt text to GitHub (a public repo's branch list is
// world-readable) and to the control plane's handoff ping — the one thing
// this module's own header promises never happens ("GitHub therefore stores
// ciphertext for anything conversational, and the control plane is told
// only names"). The human-readable title still travels, but only inside the
// sealed manifest, which only the node's private key can open.
//
// 12 hex chars matches relayd's own checkout-directory convention exactly
// (checkoutPathFor in product/relayd/src/handoff.mjs: `handoff-<id first 12
// chars>`), so a branch and its eventual checkout are recognizably the same
// handoff without embedding anything more than the id.
function handoffBranchName(handoffId) {
  return `relay/handoff-${String(handoffId).slice(0, 12)}`;
}

// ---------------------------------------------------------------------------
// WHAT MAY NOT LEAVE THE LAPTOP.
//
// The WIP commit used to be `git add -A` with `.gitignore` as the only filter,
// and a reviewer pushed three files to a real remote with it: an untracked
// `.env` (no ignore rule in that repo), a TRACKED `.env.example` the developer
// had filled in locally (`git add -A` stages a tracked file's modifications
// regardless of any ignore rule), and an `.ssh/id_rsa` nobody had thought to
// ignore. The destination is a branch on the user's own GitHub repository, and
// GitHub history is not revocable — so this is the worst possible destination
// for a live key, reached on the shut-the-laptop path where the user is by
// definition not watching.
//
// The sandbox half of this same feature (relayd's push-back) already refuses
// all three, and its own comment says in as many words that `.gitignore`
// "is not sufficient" — reason 3 there (`git add -A` stages a tracked file's
// modifications regardless of any ignore rule) is equally true here. So the
// laptop runs the SAME policy, in the same two layers, with the rule text
// vendored byte-for-byte rather than re-spelled:
//
//   layer 1  withhold every secret-shaped path `git status` reports, and TELL
//            THE USER which ones, because unlike the sandbox there is a human
//            here who can decide what to do about it.
//   layer 2  re-check what ACTUALLY reached the index — a different input from
//            layer 1's, because a path git status reported as a plain file can
//            become a directory full of secrets before `git add` runs — and
//            abort the whole handoff if anything got through.
//
// Withhold-and-report on layer 1, abort on layer 2, deliberately:
//
//  - A repo with a `.env` is the ordinary case, not the exception. Refusing
//    outright would fail nearly every handoff and push people toward whatever
//    `--force`-shaped escape got added next, which is how the key reaches
//    GitHub anyway. Withholding costs the sandbox agent a file it must not
//    have (relayd installs its own credentials into the run home; the
//    laptop's `.env` is exactly the thing that must not travel).
//  - The failure mode that makes withholding wrong is doing it SILENTLY, so
//    this does not: every withheld path is printed, on the push path and the
//    --no-push path alike, before anything is committed.
//  - Layer 2 tripping means the policy was DEFEATED rather than applied.
//    There is no partial-but-correct handoff to report at that point, so it
//    ends the command and nothing is pushed.
//
// The same two honest limits as the sandbox side apply, and for the same
// reason: this matches by NAME, so a secret pasted into notes.md still
// travels, and a symlink whose own name is not secret-shaped is committed as
// a symlink object carrying its target path. Neither is a content scanner and
// neither pretends to be.
//
// >>> BEGIN SHARED SECRET-PATH POLICY — CANONICAL COPY >>>
// One policy, one spelling. This is the answer to "what may leave the
// machine", and BOTH halves of the handoff need it: the sandbox pushing back
// (below) and the laptop pushing out (`relay handoff`, which reached GitHub
// with a .env, a tracked-and-modified .env.example and an .ssh/id_rsa before
// this text existed there). product/cli/src/commands/handoff.mjs vendors
// everything between these two markers BYTE FOR BYTE — the same arrangement
// seal.mjs already uses — and product/cli/test/handoff.test.mjs fails loudly
// if the two copies drift. Edit this copy, then paste it over the other one;
// two spellings of this contract WILL diverge, and the divergence is a live
// key in unrevocable history.
const SECRET_PATH_RULES = [
  /(^|\/)\.env($|[.\-_])/i,
  /(^|\/)\.envrc$/i,
  /(^|\/)\.secrets?(\/|$)/i,
  /(^|\/)secrets?\.(json|ya?ml|toml|ini|txt|env|enc)$/i,
  /(^|\/)\.git-credentials$/i,
  /(^|\/)\.netrc$/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.pypirc$/i,
  /(^|\/)\.aws(\/|$)/i,
  /(^|\/)\.ssh(\/|$)/i,
  /(^|\/)\.gnupg(\/|$)/i,
  /(^|\/)\.docker\/config\.json$/i,
  /(^|\/)\.config\/gh(\/|$)/i,
  /(^|\/)\.claude\/\.credentials\.json$/i,
  /(^|\/)\.codex\/auth\.json$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)($|\.)/i,
  /\.(pem|key|p12|pfx|jks|keystore|kdbx)$/i,
  /(^|\/)credentials(\.[A-Za-z0-9]+)?$/i,
  /(^|\/)service-account[^/]*\.json$/i,
  /(^|\/)[^/]*\.tfstate($|\.)/i,
];

function isSecretPath(candidate) {
  return SECRET_PATH_RULES.some((rule) => rule.test(candidate));
}
// <<< END SHARED SECRET-PATH POLICY <<<

function splitNulList(text) {
  return String(text)
    .split("\0")
    .filter((entry) => entry.length > 0);
}

// `git status --porcelain=v1 -z` records are `XY<space><path>`, and a rename or
// copy carries a second NUL-separated origin path. -z means paths are literal,
// never quoted, so there is nothing to unescape.
function parsePorcelainZ(text) {
  const fields = String(text).split("\0");
  const paths = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (field.length < 4) continue;
    const status = field.slice(0, 2);
    paths.push(field.slice(3));
    if (status[0] === "R" || status[0] === "C") index += 1; // consume the origin path
  }
  return paths;
}

// What the user is told when layer 1 withholds something. Bounded, because a
// repo can have thousands of matching paths (an untracked `.ssh` tree, say)
// and the point is that the user NOTICES, not that they scroll.
const MAX_REPORTED_WITHHELD = 20;

function reportWithheld(withheld, log) {
  if (withheld.length === 0) return;
  log("");
  log(`  Withheld ${withheld.length} secret-shaped file${withheld.length === 1 ? "" : "s"} from this handoff.`);
  log("  These were NOT committed and NOT pushed — nothing in them reached GitHub:");
  for (const entry of withheld.slice(0, MAX_REPORTED_WITHHELD)) log(`    ${entry}`);
  if (withheld.length > MAX_REPORTED_WITHHELD) {
    log(`    ... and ${withheld.length - MAX_REPORTED_WITHHELD} more`);
  }
  log("  (Matched by name. If your agent needs one of these on the other side,");
  log("   put it there deliberately — a handoff branch is not the way.)");
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

// Low-level git runner used only for the plumbing sequence below, where we
// need a custom GIT_INDEX_FILE and (for hash-object) the ability to pipe a
// raw Buffer on stdin without it round-tripping through a JS string.
function gitPlumbing(root, args, { env = process.env, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git", ["-C", root, ...args],
      { env, maxBuffer: 64 * 1024 * 1024, encoding: "buffer" },
      (error, stdout, stderr) => {
        if (error) {
          error.stderr = Buffer.isBuffer(stderr) ? stderr.toString("utf8") : String(stderr || "");
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

async function gitPlumbingText(root, args, opts) {
  return (await gitPlumbing(root, args, opts)).toString("utf8").trim();
}

// Re-throws a raw git failure as a named error when its stderr matches a
// known, previously-observed shape; otherwise re-throws it unmodified. Used
// so `bin/relay` (which just prints `error.message`) never shows a user a
// bare "Command failed: git -C ... " line for a failure mode we already
// understand the cause of.
function translateGitError(err, mapping) {
  const detail = `${err?.stderr || ""} ${err?.message || ""}`;
  for (const [pattern, code] of mapping) {
    if (pattern.test(detail)) throw new Error(code);
  }
  throw err;
}

async function refExistsLocally(root, ref, execFileImpl) {
  try {
    await git(root, ["rev-parse", "--verify", "--quiet", ref], execFileImpl);
    return true;
  } catch {
    return false;
  }
}

async function refExistsOnRemote(root, branch, execFileImpl) {
  try {
    await git(root, ["ls-remote", "--exit-code", "origin", branch], execFileImpl);
    return true;
  } catch {
    return false;
  }
}

// Watches a recorded handoff until the machine reaches a terminal state.
//
// Until this existed, `relay handoff` printed "Check your phone — it should be
// there in a moment" and exited, having proven only that the CLOUD accepted a
// row. Everything that decides whether the handoff actually works happens
// after that and elsewhere: the node leases the row, clones the branch,
// decrypts the sealed blobs, and imports the session. That takes seconds, and
// the user was given no signal for any of it — a failed import and a perfect
// success printed exactly the same line.
//
// `pending` is not success. It is the state a handoff sits in when nothing has
// collected it, which is indistinguishable — from the desk — from a machine
// that is switched off.
//
// Returns the terminal row, or {state, timedOut: true} if the budget expired.
// Never throws: a watch that fails must not turn a completed handoff into an
// error, so a broken listing simply keeps polling until the budget runs out.
async function awaitTerminalState({
  api, repo, handoffId, budgetMs, pollIntervalMs, sleepImpl, now,
}) {
  const deadline = now() + budgetMs;
  let lastState = "pending";
  for (;;) {
    try {
      const res = await api.listHandoffs(repo);
      if (res.status === 200) {
        const row = (res.json?.handoffs || []).find((entry) => entry?.id === handoffId);
        if (row?.state) {
          lastState = row.state;
          if (row.state === "ready" || row.state === "failed") return row;
        }
      }
    } catch {
      // Transport hiccup mid-watch. The handoff is already recorded; keep
      // watching rather than reporting a failure that has not happened.
    }
    if (now() >= deadline) return { id: handoffId, state: lastState, timedOut: true };
    await sleepImpl(pollIntervalMs);
  }
}

async function cmdHandoff(args = [], deps = {}) {
  const {
    home = undefined, cwd = process.cwd(), baseUrl = DEFAULT_BASE_URL, fetchImpl = fetch,
    log = console.log, machine = os.hostname(), now = () => Date.now(),
    execFileImpl = execFileAsync, env: envOverride = undefined,
    // Silent by default so every existing test stays quiet; bin/relay passes a
    // real one. Progress writes to stderr and never through `log`.
    progress = noopProgress,
    // How long to keep watching for the machine to finish, after the branch is
    // pushed and the cloud has recorded the handoff. 0 disables the wait.
    //
    // Off by default for the same reason `progress` is a no-op by default:
    // bin/relay opts in, and the existing tests — whose fetch stub answers
    // every /v1/handoffs call, GET and POST alike, with a create response —
    // would otherwise poll until the budget expired. Tests for this behaviour
    // pass a budget and a fake clock explicitly.
    waitForReadyMs = 0,
    pollIntervalMs = 1500,
    sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    // Test-only: force a specific handoff id so a collision (local or
    // remote) can be constructed deterministically instead of waiting on a
    // crypto.randomBytes clash that is never expected to happen for real.
    handoffId: handoffIdOverride = null,
  } = deps;

  const credentials = readCredentials({ home });
  if (!credentials?.sessionToken) throw new Error("not_logged_in: run relay login first");
  if (!credentials.nodeId || !credentials.nodeEncPubkey) {
    throw new Error("no_machine_pinned: run relay login after creating a machine in the app");
  }

  const repo = await requireGitHubRepo({ cwd, execFileImpl });
  const realRoot = fs.realpathSync(repo.root);
  const willPush = !args.includes("--no-push");

  const api = createCloudApi({
    baseUrl,
    sessionToken: credentials.sessionToken,
    refreshToken: credentials.refreshToken,
    home,
    fetchImpl,
  });

  // Pre-flight, before ANY work: an unregistered repo makes the cloud reject
  // the handoff at the very last step, after a branch has already been pushed
  // to GitHub — and a rejected handoff is never recorded, so nothing will ever
  // collect it. That is not a recoverable state, it is litter on the remote
  // plus a user told to wait for something that cannot arrive. Skipped for
  // --no-push, which never contacts the cloud at all.
  if (willPush) {
    const repos = await progress.run("Checking this repository is registered",
      () => api.listRepos());
    if (repos.status === 200) {
      const known = (repos.json?.repos || []).some((entry) => entry?.fullName === repo.fullName);
      if (!known) {
        throw new Error(`repo_not_registered: run \`relay init\` in this repository first (${repo.fullName})`);
      }
    }
    // A non-200 is deliberately NOT fatal: the probe is here to catch the
    // predictable misconfiguration, not to add a new way for handoff to fail.
    // If the cloud is unhappy for some other reason, the create call below
    // reports it with the real error rather than this one guessing.
  }

  const wip = await progress.run("Inspecting your working tree",
    () => workingTreeSummary({ root: repo.root, execFileImpl }));

  const requestedId = flagValue(args, "--session");
  const sessions = discoverSessions({ cwd: realRoot, home });
  const session = requestedId ? sessions.find((entry) => entry.id === requestedId) || null : sessions[0] || null;
  if (requestedId && !session) throw new Error(`unknown_session: no local session ${requestedId} for this repository`);
  if (!session) log("  No local session found — handing off the working tree with a summary instead.");

  const handoffId = handoffIdOverride || crypto.randomBytes(8).toString("hex");
  const titleOverride = flagValue(args, "--title");
  const title = titleOverride || session?.title || `Work on ${repo.fullName}`;
  const branch = handoffBranchName(handoffId);
  const ref = `refs/heads/${branch}`;

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

  // Structural guard: handoff blobs may only ever be reachable from a
  // relay/handoff-* ref. handoffBranchName always produces one; this makes
  // the invariant provable rather than assumed.
  if (!/^refs\/heads\/relay\/handoff-/.test(ref)) {
    throw new Error("refusing_to_write_blobs_off_handoff_branch");
  }

  // The handoff id is random and appended to the branch name, so a collision
  // is not expected — these are a defensive check, not a retry loop. Failing
  // loudly here is safer than silently overwriting or force-pushing a ref.
  if (await refExistsLocally(repo.root, ref, execFileImpl)) {
    throw new Error(`branch_collision: ${branch} already exists locally`);
  }
  // A network round trip to origin, and the first place a handoff can stall
  // for a noticeable time (a slow remote, an ssh key prompt, a VPN).
  if (willPush && await progress.run("Checking origin for a name collision",
    () => refExistsOnRemote(repo.root, branch, execFileImpl))) {
    throw new Error(`branch_collision: ${branch} already exists on origin`);
  }

  // The throwaway index is not file content — no plaintext, no credential —
  // but it does carry every path in the user's tree plus blob SHAs, and it
  // must not be readable by another local user. fs.chmodSync-ing the index
  // file itself does not work: `git write-tree` (below) rewrites the index
  // one more time to store its cache-tree extension, via git's own
  // lock-then-rename, which hands the file back at the process umask
  // (typically 0644) regardless of any chmod applied before it. Measured
  // against real git: the file is 0644 for its entire meaningful lifetime.
  // The fix is structural instead: put the index inside a directory created
  // with fs.mkdtempSync, which POSIX mkdtemp(3) always creates at 0700
  // regardless of umask. The directory's mode is what actually protects the
  // file — its own mode stops mattering — and removing the whole directory
  // in the `finally` below also sweeps up any other file git or a hook wrote
  // into this scope (a lock file, a split-index shard, ...), not just the
  // one exact filename this code happens to know about.
  const tmpIndexDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-handoff-index-"));
  const tmpIndex = path.join(tmpIndexDir, "index");
  // GIT_LITERAL_PATHSPECS=1 turns off ALL pathspec magic — globs, and the
  // ":(...)"/"!"/leading-":" syntax — for every plumbing call below, which is
  // mandatory now that `git add` is given a list of paths that came out of the
  // user's own working tree instead of a blanket `-A`. Without it those paths
  // are PATHSPECS, not filenames: a file named ":!wip.txt" makes the add
  // stage nothing at all (the exclusion wins) and the handoff pushes an empty
  // commit while claiming success, and a file named "*" re-globs a path layer
  // 1 just withheld straight back into the add list. relayd's push-back
  // carries the identical guard for the identical reason. (The ref-only calls
  // that go through repo.mjs's `git` — rev-parse, ls-remote, update-ref,
  // push — take no pathspec argument at all.)
  const env = {
    ...(envOverride || process.env),
    GIT_INDEX_FILE: tmpIndex,
    GIT_LITERAL_PATHSPECS: "1",
  };
  let pushed = false;

  try {
    // Seed a throwaway index from HEAD, then stage the working tree onto it —
    // tracked modifications, deletions, and (.gitignore-respecting) untracked
    // files — without writing anything to the user's real .git/index.
    await gitPlumbing(repo.root, ["read-tree", "HEAD"], { env });

    // Layer 1 of the secret-path policy (see SECRET_PATH_RULES above): stage
    // an explicit, filtered list rather than `git add -A`. `.gitignore` is
    // still a first filter — git status honours it — but it is no longer the
    // control, because it cannot be: it does not know about a key the user
    // never thought to ignore, and it does not apply at all to a tracked file
    // that was filled in locally.
    const candidates = await progress.run("Scanning changed files", async () => parsePorcelainZ(
      (await gitPlumbing(repo.root,
        ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { env })).toString("utf8"),
    ));
    const allowed = candidates.filter((entry) => !isSecretPath(entry));
    const withheld = candidates.filter((entry) => isSecretPath(entry));
    // Deliberately outside any progress step: reportWithheld writes to stdout
    // while the spinner is on stderr, and on a terminal that is one screen —
    // printing into a live animation interleaves the two.
    // Said before anything is committed, and said on every path out of here —
    // a handoff that quietly leaves a file behind is its own kind of failure.
    reportWithheld(withheld, log);

    // Phase markers from here down use start() rather than run(): each phase's
    // results are consts the following phases read, and wrapping them in
    // closures would mean re-scoping half this function to add a spinner. A
    // later start() supersedes the previous one, and the finally below stops
    // whichever was last.
    progress.start("Staging your working tree");
    // Batched so a repo with tens of thousands of changed paths cannot blow
    // the argv limit; 200 matches relayd's own batch size.
    for (let index = 0; index < allowed.length; index += 200) {
      await gitPlumbing(repo.root, ["add", "--", ...allowed.slice(index, index + 200)], { env });
    }

    progress.start("Sealing your session");
    const manifestSha = await gitPlumbingText(repo.root, ["hash-object", "-w", "--stdin"], {
      env, input: sealTo(credentials.nodeEncPubkey, Buffer.from(JSON.stringify(manifest), "utf8")),
    });
    try {
      await gitPlumbing(repo.root, ["update-index", "--add", "--cacheinfo",
        `100644,${manifestSha},${BLOB_PATH_PREFIX}/${handoffId}/manifest.enc`], { env });
    } catch (err) {
      translateGitError(err, [
        [/appears as both a file and as a directory|cannot add to the index/i,
          "handoff_path_conflict: a file named .relay/handoff already exists in this repository and blocks the handoff blob path"],
      ]);
    }

    if (sessionBytes) {
      const sessionSha = await gitPlumbingText(repo.root, ["hash-object", "-w", "--stdin"], {
        env, input: sealTo(credentials.nodeEncPubkey, sessionBytes),
      });
      try {
        await gitPlumbing(repo.root, ["update-index", "--add", "--cacheinfo",
          `100644,${sessionSha},${BLOB_PATH_PREFIX}/${handoffId}/session.enc`], { env });
      } catch (err) {
        translateGitError(err, [
          [/appears as both a file and as a directory|cannot add to the index/i,
            "handoff_path_conflict: a file named .relay/handoff already exists in this repository and blocks the handoff blob path"],
        ]);
      }
    }

    // Layer 2, and load-bearing rather than belt-and-braces: layer 1 filtered
    // the paths `git status` reported, once; this asks the index what is
    // ACTUALLY about to be committed. Those are not the same input. A path
    // status reported as a plain file can have become a directory by the time
    // `git add` reached it — the user's editor, a running agent, a build, all
    // write to this tree while the command runs — and git then stages
    // everything under it, under names layer 1 never saw and so never
    // filtered. This is also the only check that sees the sealed blobs added
    // by `update-index` above. Reaching here with a match means the policy was
    // defeated, not applied, so the command ends and nothing is pushed.
    const stagedPaths = splitNulList(
      (await gitPlumbing(repo.root, ["diff", "--cached", "--name-only", "-z"], { env })).toString("utf8"),
    );
    const leaked = stagedPaths.filter((entry) => isSecretPath(entry));
    if (leaked.length > 0) {
      for (const entry of leaked.slice(0, MAX_REPORTED_WITHHELD)) log(`    would have committed: ${entry}`);
      throw new Error(
        `refusing_to_push_secret: ${leaked.length} secret-shaped path(s) reached the handoff commit; nothing was pushed`,
      );
    }

    progress.start("Preparing the handoff branch");
    const treeSha = await gitPlumbingText(repo.root, ["write-tree"], { env });

    let commitSha;
    try {
      commitSha = await gitPlumbingText(repo.root,
        ["commit-tree", treeSha, "-p", "HEAD", "-m", `relay: handoff ${handoffId}`], { env });
    } catch (err) {
      translateGitError(err, [
        [/please tell me who you are|empty ident|unable to auto-detect email/i,
          "no_git_identity: set git user.name and user.email to hand off"],
      ]);
    }

    try {
      await git(repo.root, ["update-ref", ref, commitSha], execFileImpl);
    } catch (err) {
      translateGitError(err, [
        [/cannot lock ref|exists; cannot create/i,
          `branch_path_conflict: a branch or ref named '${branch.split("/")[0]}' already exists and blocks ${ref}`],
      ]);
    }

    if (!willPush) {
      // stop() before any log: the spinner is on stderr and this is stdout,
      // but on a terminal they share one screen.
      progress.stop();
      log(`  Prepared ${branch} locally. Nothing was pushed and no notification was sent.`);
    } else {
      // The slowest step by far, and the one that made the command look hung.
      progress.start(`Pushing ${branch} to GitHub`);
      // No --force, ever: a rejected (non-fast-forward) push must fail
      // loudly rather than overwrite whatever is already on the remote ref.
      await git(repo.root, ["push", "-q", "origin", `${ref}:${ref}`], execFileImpl);
      pushed = true;
    }
  } finally {
    // Whichever phase was last, running or failed, ends here.
    progress.stop();
    fs.rmSync(tmpIndexDir, { recursive: true, force: true });
  }

  if (!pushed) return { handoffId, branch, pushed: false };

  const ping = await progress.run("Notifying your machine",
    () => api.createHandoff({ handoffId, repo: repo.fullName, branch, nodeId: credentials.nodeId }));
  if (ping.status !== 201) {
    // This used to say "Your machine will still pick it up on its next poll."
    // It cannot. The node's poll leases handoff ROWS from the cloud, and a
    // rejected create wrote no row — so there is nothing to lease, now or
    // ever. Saying otherwise left a user waiting on a phone that was never
    // going to light up, with a branch on GitHub that nothing would consume.
    const reason = ping.json?.error || ping.status;
    log(`  Pushed ${branch}, but the cloud rejected the handoff (${reason}).`);
    log("  Your machine will NOT pick this up — it only ever collects handoffs");
    log("  the cloud recorded, and this one was not recorded.");
    if (reason === "unknown_repo") log("  Run `relay init` in this repository, then hand off again.");
    if (reason === "unknown_node") log("  Run `relay login` to re-pin this machine, then hand off again.");
    log(`  The pushed branch is unused; delete it with: git push origin --delete ${branch}`);
    return { handoffId, branch, pushed: true, notified: false, reason: String(reason) };
  }

  // Keep the phone's "On your Mac" list current. Best-effort by design: the
  // handoff has already succeeded and must not be reported as FAILED here —
  // but best-effort still means visible. A silent catch here previously hid
  // a 100%-reproducing bug (a missing nodeId that made the cloud 400 every
  // single call); "non-fatal" must never again mean "nobody finds out".
  //
  // Note for whoever reaches for this next: even a successful publish here
  // does not make the cloud close its rendezvous session early. It only
  // auto-closes once BOTH the device slot and the node slot have been read
  // (product/cloud/src/pairing.js getBlob), and relayd's collectRendezvousBlob
  // only ever reads the device slot for "sync-auth"/"session-index" kinds —
  // the node slot is never written or read on this path. So every publish,
  // failed or not, leaves its session to expire on the ordinary 15-minute TTL
  // sweep rather than closing early. That is a cloud/relayd protocol gap, not
  // something fixable from here.
  try {
    const { publishSessionIndex } = await import("./syncauth.mjs");
    // run(), so the spinner is already stopped by the time the catch below
    // logs.
    await progress.run("Updating the session list", () => publishSessionIndex({
      repoFullName: repo.fullName, root: realRoot, home: home || os.homedir(),
      api, nodeId: credentials.nodeId, nodeEncPubkey: credentials.nodeEncPubkey, machine,
    }));
  } catch (err) {
    log(`  Note: could not update the "On your Mac" session list (${err?.message || "unknown error"}).`);
    log("  Your handoff still succeeded; run `relay sync-auth` to refresh the index.");
  }

  log("");
  log(`  Handed off: ${title}`);
  log(`  Branch:     ${branch}`);
  log(`  Machine:    ${credentials.nodeId}`);

  if (waitForReadyMs <= 0) {
    log("");
    log("  Check your phone — it should be there in a moment.");
    return { handoffId, branch, pushed: true };
  }

  const outcome = await progress.run("Waiting for your machine to pick it up",
    () => awaitTerminalState({
      api, repo: repo.fullName, handoffId,
      budgetMs: waitForReadyMs, pollIntervalMs, sleepImpl, now,
    }));

  log("");
  if (outcome.state === "ready") {
    log("  Ready on your machine — open the app to pick it up.");
    return { handoffId, branch, pushed: true, state: "ready" };
  }

  if (outcome.state === "failed") {
    // The machine reached the handoff and could not use it. That is a failure
    // of the thing the user asked for, so it exits non-zero rather than
    // printing a cheerful line about checking their phone.
    const reason = outcome.reason || "unknown";
    throw new Error(
      `handoff_failed: your machine could not open this handoff (${reason}); the branch ${branch} is still on GitHub`,
    );
  }

  // Budget expired with the row still un-collected. Deliberately not an error:
  // a slow machine and a dead one look identical from here, and the handoff is
  // recorded either way, so the honest report is "not yet" plus where to look.
  log(`  Still ${outcome.state} after ${Math.round(waitForReadyMs / 1000)}s — your machine has not picked it up yet.`);
  log("  It will be collected whenever the machine next polls; check with `relay status`.");
  return { handoffId, branch, pushed: true, state: outcome.state, timedOut: true };
}

export { cmdHandoff, buildManifest, handoffBranchName, isSecretPath, awaitTerminalState };
