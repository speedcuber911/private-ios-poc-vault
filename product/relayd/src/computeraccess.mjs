// Short-lived control-plane authorization for managed/trial node data paths.
//
// The device bearer token proves which phone is calling; it does not prove
// that the account owner has kept the linked computer active. relay-cloud is
// authoritative for that second decision and renews it on the existing
// node-signed long-poll. A missing or expired lease fails closed.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const MIN_LEASE_SEC = 5;
const MAX_LEASE_SEC = 120;

function readPersistedState(statePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
    if (
      parsed?.v !== 1 ||
      typeof parsed.allowed !== "boolean" ||
      !Number.isSafeInteger(parsed.expiresAt) ||
      parsed.expiresAt <= 0
    ) return null;
    return { allowed: parsed.allowed, expiresAt: parsed.expiresAt };
  } catch {
    return null;
  }
}

function writeStateAtomic(statePath, state) {
  const tmp = `${statePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(tmp, `${JSON.stringify({ v: 1, ...state })}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(tmp, statePath);
    return true;
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* already absent */ }
    return false;
  }
}

function createComputerAccessGate({
  required = false,
  statePath,
  now = () => Date.now(),
} = {}) {
  let state = statePath ? readPersistedState(statePath) : null;

  function applyLease(lease) {
    if (
      !lease ||
      typeof lease.allowed !== "boolean" ||
      !Number.isSafeInteger(lease.leaseSec) ||
      lease.leaseSec < MIN_LEASE_SEC ||
      lease.leaseSec > MAX_LEASE_SEC
    ) {
      throw new Error("cloud_poll_invalid_computer_access");
    }
    state = {
      allowed: lease.allowed,
      expiresAt: now() + lease.leaseSec * 1000,
    };
    if (statePath) writeStateAtomic(statePath, state);
    return { ...state };
  }

  function authorize() {
    if (!required) return { ok: true };
    if (!state || state.expiresAt <= now()) {
      return {
        ok: false,
        status: 503,
        error: "computer access could not be verified",
      };
    }
    if (!state.allowed) {
      return {
        ok: false,
        status: 403,
        error: "computer is disconnected",
      };
    }
    return { ok: true };
  }

  return { applyLease, authorize };
}

const configuredDataDir = process.env.CODEX_DATA_DIR || "/var/lib/codex-api";
const configuredCloudUrl = process.env.RELAYD_CLOUD_URL || process.env.RELAYD_ENROLL_URL || "";
const computerAccessGate = createComputerAccessGate({
  // Existing direct/mTLS nodes remain independent. Managed trial nodes use a
  // device token and cloud enrollment, so they must hold a current lease.
  required: Boolean(process.env.RELAYD_DEVICE_TOKEN_HASH_FILE && configuredCloudUrl),
  statePath: path.join(configuredDataDir, "computer-access.json"),
});

export {
  MIN_LEASE_SEC,
  MAX_LEASE_SEC,
  createComputerAccessGate,
  computerAccessGate,
};
