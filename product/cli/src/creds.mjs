// Where the CLI keeps its session. The file holds a bearer session for the
// control plane and the pinned identity of the sandbox this machine hands off
// to — never repository content and never harness credentials.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const FIELDS = ["sessionToken", "refreshToken", "accountId", "nodeId", "nodeEncPubkey"];

function credentialsPath(home) {
  return path.join(home || os.homedir(), ".relay", "credentials.json");
}

function readCredentials({ home } = {}) {
  try {
    const parsed = JSON.parse(fs.readFileSync(credentialsPath(home), "utf8"));
    const result = {};
    for (const field of FIELDS) result[field] = parsed[field] ?? null;
    return result;
  } catch {
    return null;
  }
}

function writeCredentials(values, { home } = {}) {
  const filePath = credentialsPath(home);
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(filePath), 0o700);
  const merged = { ...(readCredentials({ home }) || {}), ...values };
  const output = {};
  for (const field of FIELDS) if (merged[field] != null) output[field] = merged[field];
  fs.writeFileSync(filePath, `${JSON.stringify(output, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

function clearCredentials({ home } = {}) {
  try {
    fs.unlinkSync(credentialsPath(home));
  } catch {
    // Nothing stored is the same outcome as clearing it.
  }
}

export { readCredentials, writeCredentials, clearCredentials, credentialsPath };
