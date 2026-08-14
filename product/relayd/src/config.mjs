// relayd config.mjs — extracted verbatim from relay-server/codex-api-deploy/server.mjs (W2-CORE, behavior-preserving).
import http from "node:http";
import https from "node:https";
import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";



const host = process.env.CODEX_API_HOST || "127.0.0.1";

const port = parseIntegerEnv("CODEX_API_PORT", 8787, 1, 65535);

const requireMtls = parseBooleanEnv("CODEX_REQUIRE_MTLS", true);

const dataDir = process.env.CODEX_DATA_DIR || "/var/lib/codex-api";

const jobsDir = path.join(dataDir, "jobs");

const logsDir = path.join(dataDir, "logs");

const attachmentsDir = path.join(dataDir, "attachments");

const artifactsDir = path.join(dataDir, "artifacts");

const approvalsDir = path.join(dataDir, "approvals");

const auditPath = path.join(dataDir, "audit.jsonl");

// Where a harness CLI actually lives.
//
// `/usr/bin/<name>` was hardcoded as the default, and that is only true when
// npm's global prefix is /usr. On the trial image it is not: node is unpacked
// under /opt/node, so `npm install -g @openai/codex @anthropic-ai/claude-code`
// puts them at /opt/node/bin/codex and /opt/node/bin/claude. Every trial
// sandbox therefore answered every prompt with
// `spawn /usr/bin/codex ENOENT` — both harnesses unrunnable, on every trial
// machine, from the first one ever provisioned. Cursor was unaffected only
// because its default is derived from CODEX_RUN_HOME rather than guessed.
//
// Resolution order:
//   1. the explicit env var, honoured even if it points at nothing — an
//      operator who names a path deserves an error about THAT path, not a
//      silent substitution of something else;
//   2. the conventional location, when it really is there;
//   3. the first match on PATH;
//   4. the conventional location again, so the ENOENT names the expected
//      place rather than something empty.
//
// Resolved once at import: this is a handful of existsSync calls on a fixed
// PATH, and the answer cannot change under a running daemon.
function resolveOnPath(name) {
  const entries = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const dir of entries) {
    const candidate = path.join(dir, name);
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // An unreadable PATH entry is not this function's problem — keep looking.
    }
  }
  return null;
}

function resolveHarnessBin(explicit, name, conventional) {
  if (explicit) return explicit;
  try {
    if (fs.existsSync(conventional)) return conventional;
  } catch {
    // fall through to the PATH scan
  }
  return resolveOnPath(name) || conventional;
}

const codexBin = resolveHarnessBin(process.env.CODEX_BIN, "codex", "/usr/bin/codex");

const claudeBin = resolveHarnessBin(process.env.CLAUDE_BIN, "claude", "/usr/bin/claude");

const cursorBin = process.env.CURSOR_BIN || path.join(process.env.CODEX_RUN_HOME || process.env.HOME || "/home/ec2-user", ".local", "bin", "cursor-agent");

// git binary used by worktree.mjs (job worktree push-back) and handoff.mjs
// (handoff clone/commit/push). One definition so both stay in sync.
const gitBin = process.env.RELAYD_GIT_BIN || "git";

const runHome = process.env.CODEX_RUN_HOME || process.env.HOME || "/home/ec2-user";

const codexHome = process.env.CODEX_HOME || path.join(runHome, ".codex");

const claudeHome = process.env.CLAUDE_HOME || path.join(runHome, ".claude");

const npmCacheDir = process.env.NPM_CONFIG_CACHE || process.env.npm_config_cache || path.join(runHome, ".npm-cache");

const bunCacheDir = process.env.BUN_INSTALL_CACHE_DIR || path.join(runHome, ".bun-cache");

const dangerousMode = parseBooleanEnv("CODEX_DANGEROUS_MODE", true);

const codexTransport = parseEnumEnv("RELAYD_CODEX_TRANSPORT", "app-server", ["app-server", "exec"]);

const maxConcurrent = parseIntegerEnv("CODEX_MAX_CONCURRENT", 1, 1, 16);

const maxJobStreams = parseIntegerEnv("CODEX_MAX_JOB_STREAMS", 8, 1, 64);

const jobStreamHeartbeatMs = parseIntegerEnv("CODEX_JOB_STREAM_HEARTBEAT_MS", 15000, 50, 120000);

const maxBodyBytes = parseIntegerEnv("CODEX_MAX_BODY_BYTES", 30 * 1024 * 1024, 1, 50 * 1024 * 1024);

const maxJobAttachments = parseIntegerEnv("CODEX_MAX_JOB_ATTACHMENTS", 6, 0, 20);

const maxJobAttachmentBytes = parseIntegerEnv("CODEX_MAX_JOB_ATTACHMENT_BYTES", 8 * 1024 * 1024, 1, 25 * 1024 * 1024);

const maxJobAttachmentTotalBytes = parseIntegerEnv(
  "CODEX_MAX_JOB_ATTACHMENT_TOTAL_BYTES",
  18 * 1024 * 1024,
  1,
  50 * 1024 * 1024,
);

const maxTranscriptionAudioBytes = parseIntegerEnv(
  "CODEX_MAX_TRANSCRIPTION_AUDIO_BYTES",
  25 * 1024 * 1024,
  1024,
  250 * 1024 * 1024,
);

const maxOutputBytes = parseIntegerEnv("CODEX_MAX_OUTPUT_BYTES", 5 * 1024 * 1024, 1, 50 * 1024 * 1024);

const maxJobArtifacts = parseIntegerEnv("CODEX_MAX_JOB_ARTIFACTS", 12, 0, 50);

const maxArtifactBytes = parseIntegerEnv("CODEX_MAX_ARTIFACT_BYTES", 1024 * 1024, 1024, 25 * 1024 * 1024);

const maxArtifactTotalBytes = parseIntegerEnv("CODEX_MAX_ARTIFACT_TOTAL_BYTES", 5 * 1024 * 1024, 1024, 50 * 1024 * 1024);

const maxJobSkills = parseIntegerEnv("CODEX_MAX_JOB_SKILLS", 6, 0, 20);

const maxSkillPromptBytes = parseIntegerEnv("CODEX_MAX_SKILL_PROMPT_BYTES", 20 * 1024, 1024, 256 * 1024);

const maxSkillDiscoveryFiles = parseIntegerEnv("CODEX_MAX_SKILL_DISCOVERY_FILES", 600, 1, 5000);

const responseOutputBytes = Math.min(
  parseIntegerEnv("CODEX_RESPONSE_OUTPUT_BYTES", 64 * 1024, 1, maxOutputBytes),
  maxOutputBytes,
);

const listOutputBytes = Math.min(
  parseIntegerEnv("CODEX_LIST_OUTPUT_BYTES", 4 * 1024, 1, responseOutputBytes),
  responseOutputBytes,
);

const maxTimeoutMs = parseIntegerEnv("CODEX_MAX_TIMEOUT_MS", 30 * 60 * 1000, 1000, 24 * 60 * 60 * 1000);

const defaultTimeoutMs = Math.min(
  parseIntegerEnv("CODEX_DEFAULT_TIMEOUT_MS", 10 * 60 * 1000, 1000, 24 * 60 * 60 * 1000),
  maxTimeoutMs,
);

const threadSummaryCharacters = parseIntegerEnv("CODEX_THREAD_SUMMARY_CHARACTERS", 240, 40, 2000);

const workspaceBrowseRoot = realpathOrResolve(
  process.env.CODEX_WORKSPACE_BROWSE_ROOT || process.env.CODEX_WORKSPACE_ROOT || "/srv/codex-workspaces",
);

const maxWorkspaceDirEntries = parseIntegerEnv("CODEX_MAX_WORKSPACE_DIR_ENTRIES", 100, 1, 1000);

const maxFsListEntries = parseIntegerEnv("CODEX_FS_MAX_LIST_ENTRIES", 500, 1, 10000);

const maxFsReadBytes = parseIntegerEnv("CODEX_FS_MAX_READ_BYTES", 1024 * 1024, 1024, 50 * 1024 * 1024);

const maxFsFileBytes = Math.max(
  parseIntegerEnv("CODEX_FS_MAX_FILE_BYTES", 25 * 1024 * 1024, 1024, 500 * 1024 * 1024),
  maxFsReadBytes,
);

const fsReadDenylist = splitCsv(
  process.env.CODEX_FS_READ_DENYLIST ||
    ".env*,*.pem,*.key,*.p12,*.pfx,*.crt,*.csr,*.der,*.jks,*.keystore,*.mobileconfig,.netrc,.npmrc,credentials,credentials.json,id_rsa,id_dsa,id_ecdsa,id_ed25519",
).map(compileDenyPattern);


const terminalStatuses = new Set(["succeeded", "failed", "cancelled", "timeout"]);

const allowedReasoningEfforts = new Set(["low", "medium", "high", "xhigh"]);

const allowedJobProviders = new Set(["codex", "claude", "cursor"]);

const allowedChatProviders = new Set(["codex", "azure", "bedrock"]);

const allowedThreadProviders = new Set([...allowedJobProviders, ...allowedChatProviders]);

const allowedClaudePermissionModes = new Set(["acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"]);

const allowedCodexApprovalPolicies = new Set(["untrusted", "on-failure", "on-request", "never"]);

const claudeAwsProfile = cleanOptionalAwsProfile(process.env.CLAUDE_AWS_PROFILE);

if (claudeAwsProfile && claudeAwsProfile !== "sigiq") {
  throw new Error("Bedrock access requires CLAUDE_AWS_PROFILE=sigiq; leave it unset for direct Claude subscription auth.");
}

const claudeAwsRegion = cleanOptionalAwsProfile(
  process.env.CLAUDE_AWS_REGION || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION,
);

const bedrockRegion = cleanOptionalAwsProfile(
  process.env.BEDROCK_REGION || process.env.CLAUDE_AWS_REGION || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1",
);

const bedrockRuntimeEndpoint = cleanOptionalEndpoint(process.env.BEDROCK_RUNTIME_ENDPOINT);

const claudeModelAliases = {
  sonnet: process.env.CLAUDE_SONNET_MODEL || "sonnet",
  opus: process.env.CLAUDE_OPUS_MODEL || "opus",
  haiku: process.env.CLAUDE_HAIKU_MODEL || "haiku",
};

const claudeDefaultModel = normalizeClaudeModel(cleanOptionalModel(process.env.CLAUDE_DEFAULT_MODEL || "sonnet"));

const azureSpeechEndpoint = cleanOptionalEndpoint(process.env.AZURE_SPEECH_ENDPOINT);

const azureSpeechApiKey = cleanOptionalSecret(process.env.AZURE_SPEECH_API_KEY || process.env.AZURE_SPEECH_KEY);

const azureSpeechApiVersion = cleanApiVersion(process.env.AZURE_SPEECH_API_VERSION || "2025-10-15");

const azureSpeechModel = cleanDisplayName(process.env.AZURE_SPEECH_TRANSCRIPTION_MODEL || "mai-transcribe-1", "Azure Speech transcription model", 120);

const azureSpeechLocales = splitCsv(process.env.AZURE_SPEECH_LOCALES || "en");

const azureOpenAiEndpoint = cleanOptionalEndpoint(process.env.AZURE_OPENAI_ENDPOINT);

const azureOpenAiApiKey = cleanOptionalSecret(process.env.AZURE_OPENAI_API_KEY);

const azureOpenAiApiVersion = cleanApiVersion(process.env.AZURE_OPENAI_API_VERSION || "2025-01-01-preview");

const proxyBaseUrl = cleanOptionalEndpoint(process.env.CODEX_PROXY_BASE_URL || process.env.CODEX_REMOTE_BASE_URL);

const proxyClientCertPath = cleanOptionalFilePath(process.env.CODEX_PROXY_CLIENT_CERT || process.env.CODEX_REMOTE_CLIENT_CERT);

const proxyClientKeyPath = cleanOptionalFilePath(process.env.CODEX_PROXY_CLIENT_KEY || process.env.CODEX_REMOTE_CLIENT_KEY);

// ---------------------------------------------------------------------------
// Listen modes (W2 "server — two listen modes").
//
//   direct    (default, historical behavior) — a plain HTTP listener on
//             CODEX_API_HOST:CODEX_API_PORT behind a TLS-terminating gateway
//             that verifies the client cert and forwards x-ssl-client-*.
//   tunneled  — the same router served over the W1 broker; TLS (including
//             the device client cert) terminates ON THIS NODE, and the
//             x-ssl-client-* headers are derived from the peer certificate.
//   both      — run the two side by side.
//
// Unset => "direct" => byte-identical startup to before this knob existed.
const listenMode = parseEnumEnv("RELAYD_LISTEN_MODE", "direct", ["direct", "tunneled", "both"]);

const listensDirect = listenMode === "direct" || listenMode === "both";

const listensTunneled = listenMode === "tunneled" || listenMode === "both";

// Broker endpoint the node dials out to (tunneled mode only).
const tunnelHost = cleanOptionalHostname(process.env.RELAYD_TUNNEL_HOST, "RELAYD_TUNNEL_HOST");

const tunnelPort = parseIntegerEnv("RELAYD_TUNNEL_PORT", 443, 1, 65535);

// Public hostname whose SAN the node TLS server certificate must carry. The
// broker routes on this name (SNI passthrough), so it must be
// `<node-id><suffix>` unless the operator pins it explicitly.
const tunnelSuffix = cleanDnsSuffix(process.env.RELAYD_TUNNEL_SUFFIX, ".tun.test");

const tunnelSni = cleanOptionalHostname(process.env.RELAYD_TUNNEL_SNI, "RELAYD_TUNNEL_SNI");

const tunnelHeartbeatMs = parseIntegerEnv("RELAYD_TUNNEL_HEARTBEAT_MS", 15000, 1000, 300000);

const tunnelBackoffBaseMs = parseIntegerEnv("RELAYD_TUNNEL_BACKOFF_MS", 1000, 50, 60000);

const tunnelBackoffMaxMs = Math.max(
  parseIntegerEnv("RELAYD_TUNNEL_BACKOFF_MAX_MS", 30000, 50, 600000),
  tunnelBackoffBaseMs,
);

// Control-plane base URL for handoff pickup and event push. Trial sandboxes
// already receive RELAYD_ENROLL_URL, so that is the fallback; empty disables
// every cloud-facing loop.
const cloudUrl = cleanOptionalUrlBase(process.env.RELAYD_CLOUD_URL || process.env.RELAYD_ENROLL_URL || "", "RELAYD_CLOUD_URL");

// Enroll-delivered Ed25519 public key (raw 32-byte base64url). Empty means
// this node cannot accept browser grants; the phone device-token path is
// unchanged. Never a signing key — HMAC grant secrets are a spec violation.
const grantPublicKey = (process.env.RELAYD_GRANT_PUBLIC_KEY || "").trim() || null;

const nodeId = (process.env.RELAYD_NODE_ID || "").trim() || null;

const handoffEnabled = parseBooleanEnv("RELAYD_HANDOFF_ENABLED", true);

const handoffPollWaitSec = parseIntegerEnv("RELAYD_HANDOFF_POLL_WAIT_SEC", 20, 0, 60);

const chatsDir = path.join(dataDir, "chats");

const pairingDir = path.join(dataDir, "pairing");

fs.mkdirSync(dataDir, { recursive: true });

fs.mkdirSync(jobsDir, { recursive: true });

fs.mkdirSync(logsDir, { recursive: true });

fs.mkdirSync(attachmentsDir, { recursive: true });

fs.mkdirSync(artifactsDir, { recursive: true });

fs.mkdirSync(chatsDir, { recursive: true });

// The harness home directories relayd NAMES in every child's environment
// (buildJobEnv sets HOME=runHome and CODEX_HOME=codexHome).
//
// Codex refuses to start when CODEX_HOME does not exist:
//
//   Error finding codex home: CODEX_HOME points to "/home/relay/.codex",
//   but that path does not exist
//
// and relayd was pointing at a directory it never created. It only ever
// appeared to work because `relay sync-auth` creates the directory as a side
// effect of writing auth.json — so a machine that had been synced was fine and
// a fresh one failed every prompt. Same shape as the /usr/bin/codex default:
// naming a path is not the same as ensuring it.
//
// Guarded, unlike the directories above: those are relayd's own data dir and a
// failure there is fatal by design, but CODEX_HOME is operator-supplied on a
// BYO install and may legitimately point somewhere this process cannot create.
// Refusing to boot over that would be worse than letting the harness report it
// — which it does, clearly, in the message above.
for (const dir of [runHome, codexHome]) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // Left to the harness to report; see the comment above.
  }
}

// ---------------------------------------------------------------------------
// Client-certificate subject allowlist (API.md §1.2).
//
// An RFC 2253 DN CONTAINS commas (`CN=device,OU=Devices,O=Relay`), so the
// historical comma-split could only ever express SINGLE-RDN subjects: any
// realistic device DN was shredded into fragments and 403'd forever. Three
// input forms are accepted, disambiguated by the first character of the value
// and by the presence of a newline — neither of which can appear unescaped
// inside an RFC 2253 DN:
//
//   1. JSON array   `["CN=device,OU=Devices,O=Relay","CN=laptop,O=Relay"]`
//      (preferred; the ONLY form that can express multi-RDN DNs in a
//      single-line systemd EnvironmentFile)
//   2. newline-separated — one complete DN per line
//   3. legacy comma-separated — kept working for existing single-RDN configs;
//      a DN containing a comma CANNOT be expressed this way, by construction
//
// `RELAYD_ALLOWED_CERT_SUBJECTS` wins when set; `CODEX_ALLOWED_CERT_SUBJECTS`
// remains supported so existing installs keep working untouched.
const allowedCertSubjectsPath = path.join(dataDir, "allowed-cert-subjects.json");

const allowedCertSubjectsEnvName =
  (process.env.RELAYD_ALLOWED_CERT_SUBJECTS || "").trim() !== ""
    ? "RELAYD_ALLOWED_CERT_SUBJECTS"
    : "CODEX_ALLOWED_CERT_SUBJECTS";

const allowedCertSubjects = new Set([
  ...parseCertSubjectList(process.env[allowedCertSubjectsEnvName], allowedCertSubjectsEnvName),
  ...readPersistedCertSubjects(),
]);

// Auto-allowlisting of subjects this node itself minted during a successfully
// authenticated pairing (pairing.mjs). Deliberately NOT silent: it is a named
// knob, it only ever admits a subject from a certificate this node just
// issued, every addition is written to a reviewable file next to the audit
// log, and it emits `cert_subject_allowlisted`. Set to false to keep a frozen,
// operator-managed allowlist.
const pairingAutoAllow = parseBooleanEnv("RELAYD_PAIRING_AUTOALLOW", true);

// ---------------------------------------------------------------------------
// Pairing listener (API.md §2.3). Its own listener, ALWAYS separate from the
// mTLS data listener: POST /v1/pair is authenticated by the single-use pairing
// secret plus an HMAC tag, never by a client certificate, so it must never be
// reachable on the port that serves data routes.
const pairingEnabled = parseBooleanEnv("RELAYD_PAIRING_ENABLED", true);

// LOOPBACK BY DEFAULT, INDEPENDENTLY OF CODEX_API_HOST. POST /v1/pair is plain
// HTTP and it MINTS mTLS client certificates; the TLS-terminating gateway that
// fronts CODEX_API_HOST:CODEX_API_PORT is not in front of this listener at all.
// Inheriting CODEX_API_HOST therefore published a cert-minting endpoint on
// every interface — in the clear — the moment an operator moved the data
// listener off loopback, with no signal anywhere. Exposing it is now an
// explicit opt-in: set RELAYD_PAIRING_HOST (dist/install.sh writes the key).
const pairingHost = cleanListenHost(process.env.RELAYD_PAIRING_HOST, "127.0.0.1");

// 0 (the default) means "ask the kernel for a free port at bind time".
// relayd must never claim an address nobody allocated to it: defaulting to
// CODEX_API_PORT + 1 made every daemon squat on its neighbour's port and kill
// that neighbour with EADDRINUSE. Operators who need a STABLE address (a
// gateway rule, an SSH tunnel) set RELAYD_PAIRING_PORT explicitly; the daemon
// records whatever it actually bound (see recordPairingListener) so `relayd
// pair` in another process can still print a usable URL.
const pairingPort = parseIntegerEnv("RELAYD_PAIRING_PORT", 0, 0, 65535);

if (pairingEnabled && pairingPort !== 0 && pairingPort === port && pairingHost === host) {
  throw new Error(
    "RELAYD_PAIRING_PORT must differ from CODEX_API_PORT — /v1/pair is never served on the mTLS data listener",
  );
}

// ---------------------------------------------------------------------------
// Atomic single-file writes — config.mjs's own copy of store.mjs's two rules.
//
// config.mjs cannot import store.mjs (store.mjs imports config.mjs), so the
// rules are restated here for the two files config.mjs owns:
// allowed-cert-subjects.json and pairing/listener.json. "Only one relayd runs"
// is NOT an assumption this code may make — `relayd devices revoke`, `relayd
// pair` and a second daemon started against the same CODEX_DATA_DIR all touch
// these paths concurrently.
//
// withFileLock/writeFileAtomic are exported so cloudclient.mjs can reuse rule
// 2 for its own per-call cloud-event-seq counter (task-11 review follow-up):
// this lock FAILS OPEN (degrades to unsynchronized rather than blocking
// indefinitely) and self-heals a lock left behind by a crashed holder (the
// staleMs check below) — the right failure mode for a lock taken on every
// outbound push in a long-running daemon, where a stuck lock would silently
// blackhole every future event exactly like the bug this lock exists to
// avoid. identity.mjs's withEncKeyLock is deliberately the opposite (fails
// closed, no staleness recovery) because it guards one-time, irreversible
// keypair generation instead — do not swap the two.
//
// 1. UNIQUE TEMP NAME. A fixed `<file>.tmp` is shared mutable state between
//    processes: the interleaving is write(A) -> write(B) -> rename(A) ->
//    rename(B), where A's rename moves the temp away and B's rename fails with
//    `ENOENT ... rename '<file>.tmp'`. On the pairing path that error escaped
//    allowCertSubject and redeemPairing as a 500 to the phone AFTER the cert
//    had been issued, the device enrolled and the one-shot code burned, so the
//    user had to start pairing over. The same interleaving can also rename a
//    HALF-WRITTEN temp into place, which for listener.json leaves `relayd pair`
//    with nothing parseable to print. pid + random bytes make the temp private
//    to one writer; rename itself stays atomic, so a reader sees the old file
//    or the new one and never a partial.
//
// 2. LOCK THE READ-MODIFY-WRITE. A unique temp fixes the COLLISION but not the
//    LOST UPDATE: two processes can each read allowed-cert-subjects.json,
//    append their own subject, and each rename a complete file over the other's
//    — and a dropped entry means a genuinely paired device is 403'd on the data
//    path until an operator notices. Serializing the read-modify-write is the
//    only fix; the claim uses the same O_EXCL create as store.mjs. It fails
//    closed either way: a lost subject denies access, it never grants it.
// ---------------------------------------------------------------------------
const fileLockStaleMs = 10 * 1000;
const fileLockTimeoutMs = 5 * 1000;

// Timer-free synchronous nap; contention here is measured in milliseconds and
// these writers are synchronous by contract.
function napSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireFileLock(lockPath) {
  const deadline = Date.now() + fileLockTimeoutMs;
  for (;;) {
    try {
      fs.writeFileSync(lockPath, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
      return true;
    } catch (error) {
      if (error.code !== "EEXIST") return false;
    }
    // Take over a lock left behind by a process that died holding it.
    try {
      if (Date.now() - fs.statSync(lockPath).mtimeMs > fileLockStaleMs) fs.unlinkSync(lockPath);
    } catch {
      // Someone else already cleared it.
    }
    if (Date.now() >= deadline) return false;
    napSync(2);
  }
}

// Runs `mutate` with `<file>.lock` held. Degrades to running it unsynchronized
// rather than refusing the write: losing an update is bad, refusing to record a
// paired device at all is worse.
function withFileLock(file, mutate) {
  const lockPath = `${file}.lock`;
  const locked = acquireFileLock(lockPath);
  try {
    return mutate();
  } finally {
    if (locked) {
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // Already taken over as stale.
      }
    }
  }
}

// tmp + rename with a temp name that is UNIQUE PER WRITE (rule 1 above).
function writeFileAtomic(file, contents, { mode } = {}) {
  const tmpFile = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tmpFile, contents, mode ? { encoding: "utf8", mode } : "utf8");
    fs.renameSync(tmpFile, file);
  } catch (error) {
    // Never leave the temp behind: it is now unreachable by name.
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      // Already gone.
    }
    throw error;
  }
}

// Where the running daemon records the address its pairing listener actually
// bound. `relayd pair` and `relayd doctor` are SEPARATE, short-lived processes:
// with an ephemeral port they can only print a usable URL by reading it back.
const pairingListenerStatePath = path.join(pairingDir, "listener.json");

// Written by the daemon right after a successful bind. Atomic (unique tmp +
// rename) so a concurrent reader never sees a half-written record and a second
// daemon binding at the same instant cannot ENOENT this one out of having any
// recorded address at all. No lock: this is a whole-file overwrite, not a
// read-modify-write, and "the daemon that bound last wins" is the intended
// semantics.
function recordPairingListener({ host: boundHost, port: boundPort }) {
  if (!Number.isInteger(boundPort) || boundPort <= 0) return false;
  try {
    fs.mkdirSync(pairingDir, { recursive: true });
    const record = {
      host: boundHost,
      port: boundPort,
      pid: process.pid,
      startedAt: new Date().toISOString(),
    };
    writeFileAtomic(pairingListenerStatePath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

// Only trusted while the process that wrote it is still alive: a leftover
// record from a dead daemon must never send the phone at a stale port.
function readPairingListener() {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(pairingListenerStatePath, "utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  if (!Number.isInteger(parsed.port) || parsed.port <= 0) return null;
  if (!Number.isInteger(parsed.pid) || parsed.pid <= 0) return null;
  try {
    process.kill(parsed.pid, 0);
  } catch (error) {
    // EPERM => the pid exists but belongs to another user; anything else
    // (ESRCH) => the writer is gone and the record is stale.
    if (error.code !== "EPERM") return null;
  }
  return { host: typeof parsed.host === "string" && parsed.host ? parsed.host : pairingHost, port: parsed.port };
}

// Base URL the phone should reach for POST /v1/pair (printed by `relayd
// pair`). Unset => derived from the pairing listener bind address.
const pairingAdvertiseBase = cleanOptionalUrlBase(process.env.RELAYD_PAIRING_ADVERTISE, "RELAYD_PAIRING_ADVERTISE");

function pairingEndpointUrl() {
  if (pairingAdvertiseBase) return `${pairingAdvertiseBase}/v1/pair`;
  const live = pairingPort === 0 ? readPairingListener() : null;
  const effectiveHost = live ? live.host : pairingHost;
  const effectivePort = pairingPort !== 0 ? pairingPort : live ? live.port : null;
  const displayHost = effectiveHost === "0.0.0.0" || effectiveHost === "::" ? "<node-address>" : effectiveHost;
  const bracketed = displayHost.includes(":") && !displayHost.startsWith("<") ? `[${displayHost}]` : displayHost;
  // No configured port and no live daemon: say so rather than invent one.
  const displayPort = effectivePort === null ? "<pairing-port>" : effectivePort;
  return `http://${bracketed}:${displayPort}/v1/pair`;
}

// True when the pairing listener only accepts loopback connections, i.e. the
// phone cannot reach it without a gateway/tunnel in front.
function pairingIsLoopbackOnly() {
  return !pairingAdvertiseBase && /^(127\.|::1$|localhost$)/.test(pairingHost);
}


// Accepts JSON-array / newline / legacy-comma forms; see the block comment
// above. Returns complete DN strings, never fragments.
function parseCertSubjectList(value, name = "CODEX_ALLOWED_CERT_SUBJECTS") {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return [];
  if (text.startsWith("[")) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`${name} starts with "[" but is not valid JSON`);
    }
    if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
      throw new Error(`${name} must be a JSON array of subject DN strings`);
    }
    return parsed.map((entry) => entry.trim()).filter(Boolean);
  }
  if (/[\r\n]/.test(text)) {
    return text.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
  }
  return splitCsv(text);
}


function readPersistedCertSubjects() {
  try {
    const parsed = JSON.parse(fs.readFileSync(allowedCertSubjectsPath, "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry) => (entry && typeof entry.subject === "string" ? entry.subject.trim() : ""))
      .filter(Boolean);
  } catch {
    return [];
  }
}


// Adds one subject to the live allowlist and to the persisted file so it
// survives a restart. Returns true when the subject was newly added. Callers
// are responsible for the audit line (config.mjs must not import audit.mjs —
// audit.mjs imports config.mjs).
//
// The persist step is a read-modify-write on a file other processes also write
// (pairing.mjs calls this on every successful pairing, and RELAYD_PAIRING_AUTOALLOW
// defaults true), so it runs under `<file>.lock` with a unique temp — see the
// two rules above writeFileAtomic.
function allowCertSubject(subject, { reason = "manual", deviceId = null } = {}) {
  if (typeof subject !== "string") return false;
  const value = subject.trim();
  if (!value || value.length > 1024 || /[\0\r\n]/.test(value)) return false;
  if (allowedCertSubjects.has(value)) return false;
  allowedCertSubjects.add(value);
  withFileLock(allowedCertSubjectsPath, () => {
    let existing = [];
    try {
      const parsed = JSON.parse(fs.readFileSync(allowedCertSubjectsPath, "utf8"));
      if (Array.isArray(parsed)) existing = parsed;
    } catch {
      existing = [];
    }
    // Re-read happens INSIDE the lock: another process may have persisted this
    // exact subject while we waited, and the file must not grow a duplicate.
    const already = existing.some(
      (entry) => entry && typeof entry.subject === "string" && entry.subject.trim() === value,
    );
    if (already) return;
    existing.push({ subject: value, reason, deviceId, addedAt: new Date().toISOString() });
    writeFileAtomic(allowedCertSubjectsPath, `${JSON.stringify(existing, null, 2)}\n`, { mode: 0o600 });
  });
  return true;
}


function cleanListenHost(value, fallback) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return fallback;
  if (/[\0\r\n\s]/.test(text) || text.length > 255) {
    throw new Error("RELAYD_PAIRING_HOST must be a bind address");
  }
  return text;
}


function cleanOptionalUrlBase(value, name) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return null;
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
  if (!["https:", "http:"].includes(url.protocol) || !url.host) {
    throw new Error(`${name} must include a supported protocol and host`);
  }
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}


function parseIntegerEnv(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}


function parseBooleanEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (/^(1|true|yes|on)$/i.test(raw)) return true;
  if (/^(0|false|no|off)$/i.test(raw)) return false;
  throw new Error(`${name} must be true or false`);
}


function parseEnumEnv(name, fallback, allowed) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = raw.trim().toLowerCase();
  if (!allowed.includes(value)) {
    throw new Error(`${name} must be one of ${allowed.join("|")}`);
  }
  return value;
}


// DNS name (or null when unset). Deliberately stricter than the RFC: the
// value ends up in a certificate SAN and in an SNI comparison.
function cleanOptionalHostname(value, name) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return null;
  if (!/^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/.test(text)) {
    throw new Error(`${name} must be a DNS hostname`);
  }
  return text.toLowerCase();
}


// Leading-dot DNS suffix appended to the node id to form the tunnel SNI.
function cleanDnsSuffix(value, fallback) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return fallback;
  const withDot = text.startsWith(".") ? text : `.${text}`;
  if (!/^\.[A-Za-z0-9]([A-Za-z0-9.-]{0,250}[A-Za-z0-9])?$/.test(withDot)) {
    throw new Error("RELAYD_TUNNEL_SUFFIX must be a DNS suffix such as .tun.<domain>");
  }
  return withDot.toLowerCase();
}


function splitCsv(value) {
  return (value || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}


function splitPathList(value) {
  return (value || "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
}


function cleanDisplayName(value, name, maxLength) {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || /[\0\r\n]/.test(value)) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}


function cleanOptionalEndpoint(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return null;
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error("AZURE_SPEECH_ENDPOINT must be a valid URL");
  }
  if (!["https:", "http:"].includes(url.protocol) || !url.host) {
    throw new Error("AZURE_SPEECH_ENDPOINT must include a supported protocol and host");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}


function cleanOptionalSecret(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return null;
  if (/[\0\r\n]/.test(text)) {
    throw new Error("AZURE_SPEECH_API_KEY is invalid");
  }
  return text;
}


function cleanOptionalFilePath(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return null;
  if (/[\0\r\n]/.test(text)) {
    throw new Error("proxy client certificate path is invalid");
  }
  return path.resolve(text);
}


function cleanEnvironmentVariableName(value, label) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,120}$/.test(text)) {
    throw new Error(`${label} is invalid`);
  }
  return text;
}


function cleanApiVersion(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!/^\d{4}-\d{2}-\d{2}(?:-preview)?$/.test(text)) {
    throw new Error("AZURE_SPEECH_API_VERSION is invalid");
  }
  return text;
}


function compileDenyPattern(pattern) {
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`, "i");
}


function cleanOptionalModel(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,100}$/.test(value)) {
    throw Object.assign(new Error("model is invalid"), { status: 400 });
  }
  return value;
}


function cleanOptionalAwsProfile(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,100}$/.test(value)) {
    throw Object.assign(new Error("AWS profile or region is invalid"), { status: 400 });
  }
  return value;
}


function normalizeClaudeModel(model) {
  return claudeModelAliases[model] || model;
}


function realpathOrResolve(value) {
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}


export {
  host,
  port,
  requireMtls,
  allowedCertSubjects,
  allowedCertSubjectsPath,
  allowCertSubject,
  parseCertSubjectList,
  pairingAutoAllow,
  pairingEnabled,
  pairingHost,
  pairingPort,
  pairingAdvertiseBase,
  pairingEndpointUrl,
  pairingIsLoopbackOnly,
  pairingListenerStatePath,
  recordPairingListener,
  readPairingListener,
  writeFileAtomic,
  withFileLock,
  pairingDir,
  dataDir,
  jobsDir,
  logsDir,
  attachmentsDir,
  artifactsDir,
  approvalsDir,
  auditPath,
  codexBin,
  claudeBin,
  cursorBin,
  gitBin,
  runHome,
  codexHome,
  claudeHome,
  npmCacheDir,
  bunCacheDir,
  dangerousMode,
  codexTransport,
  maxConcurrent,
  maxJobStreams,
  jobStreamHeartbeatMs,
  maxBodyBytes,
  maxJobAttachments,
  maxJobAttachmentBytes,
  maxJobAttachmentTotalBytes,
  maxTranscriptionAudioBytes,
  maxOutputBytes,
  maxJobArtifacts,
  maxArtifactBytes,
  maxArtifactTotalBytes,
  maxJobSkills,
  maxSkillPromptBytes,
  maxSkillDiscoveryFiles,
  responseOutputBytes,
  listOutputBytes,
  maxTimeoutMs,
  defaultTimeoutMs,
  threadSummaryCharacters,
  workspaceBrowseRoot,
  maxWorkspaceDirEntries,
  maxFsListEntries,
  maxFsReadBytes,
  maxFsFileBytes,
  fsReadDenylist,
  terminalStatuses,
  allowedReasoningEfforts,
  allowedJobProviders,
  allowedChatProviders,
  allowedThreadProviders,
  allowedClaudePermissionModes,
  allowedCodexApprovalPolicies,
  claudeAwsProfile,
  claudeAwsRegion,
  bedrockRegion,
  bedrockRuntimeEndpoint,
  claudeModelAliases,
  claudeDefaultModel,
  azureSpeechEndpoint,
  azureSpeechApiKey,
  azureSpeechApiVersion,
  azureSpeechModel,
  azureSpeechLocales,
  azureOpenAiEndpoint,
  azureOpenAiApiKey,
  azureOpenAiApiVersion,
  proxyBaseUrl,
  proxyClientCertPath,
  proxyClientKeyPath,
  listenMode,
  listensDirect,
  listensTunneled,
  tunnelHost,
  tunnelPort,
  tunnelSuffix,
  tunnelSni,
  tunnelHeartbeatMs,
  tunnelBackoffBaseMs,
  tunnelBackoffMaxMs,
  cloudUrl,
  grantPublicKey,
  nodeId,
  handoffEnabled,
  handoffPollWaitSec,
  chatsDir,
  parseIntegerEnv,
  parseBooleanEnv,
  parseEnumEnv,
  cleanOptionalHostname,
  cleanDnsSuffix,
  splitCsv,
  splitPathList,
  cleanDisplayName,
  cleanOptionalEndpoint,
  cleanOptionalSecret,
  cleanOptionalFilePath,
  cleanEnvironmentVariableName,
  cleanApiVersion,
  compileDenyPattern,
  cleanOptionalModel,
  cleanOptionalAwsProfile,
  normalizeClaudeModel,
  realpathOrResolve,
};
