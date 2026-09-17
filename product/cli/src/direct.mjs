import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";

const DIRECT_CONFIG_VERSION = 1;
const DEVICE_SLOT = "device-blob";
const NODE_SLOT = "node-blob";
const MAC_LABEL = "relay-pair-mac-v1";
const DEVICE_TOKEN_LABEL = "relay-device-token-v1";
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

function directConfigPath(home = os.homedir()) {
  return path.join(home, ".relay", "direct.json");
}

function readDirectConfig({ home = os.homedir() } = {}) {
  try {
    const parsed = JSON.parse(fs.readFileSync(directConfigPath(home), "utf8"));
    if (
      parsed?.v !== DIRECT_CONFIG_VERSION ||
      typeof parsed.apiBaseUrl !== "string" ||
      typeof parsed.deviceToken !== "string" ||
      typeof parsed.caPem !== "string"
    ) return null;
    return { ...parsed, workspaceMappings: parsed.workspaceMappings || {} };
  } catch {
    return null;
  }
}

function writeDirectConfig(values, { home = os.homedir() } = {}) {
  const filePath = directConfigPath(home);
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const prior = readDirectConfig({ home }) || { v: DIRECT_CONFIG_VERSION, workspaceMappings: {} };
  const output = {
    ...prior,
    ...values,
    v: DIRECT_CONFIG_VERSION,
    workspaceMappings: values.workspaceMappings || prior.workspaceMappings || {},
  };
  const temporary = `${filePath}.new-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, `${JSON.stringify(output, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, filePath);
  fs.chmodSync(filePath, 0o600);
  return output;
}

function b64urlDecodeText(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(`pairing_link_invalid_${label}`);
  }
  try {
    return Buffer.from(value, "base64url").toString("utf8");
  } catch {
    throw new Error(`pairing_link_invalid_${label}`);
  }
}

function parsePairingLink(raw) {
  let url;
  try {
    url = new URL(String(raw || "").trim());
  } catch {
    throw new Error("pairing_link_invalid");
  }
  const fields = new URLSearchParams(url.hash.replace(/^#/, ""));
  if (fields.get("v") !== "1") throw new Error("pairing_link_unsupported_version");
  const secret = fields.get("t");
  const nodeId = fields.get("n");
  const nodeName = fields.get("m") || nodeId;
  const pin = fields.get("f");
  if (!secret || !nodeId || !pin) throw new Error("pairing_link_missing_fields");
  if (!/^[A-Za-z0-9_-]{20,256}$/.test(secret)) throw new Error("pairing_link_invalid_token");
  if (!/^[A-Za-z0-9_-]{43}$/.test(pin)) throw new Error("pairing_link_invalid_pin");
  const pairUrl = b64urlDecodeText(fields.get("p"), "pair_url");
  const apiBaseUrl = b64urlDecodeText(fields.get("a"), "api_url");
  for (const [label, value] of [["pair_url", pairUrl], ["api_url", apiBaseUrl]]) {
    let parsed;
    try { parsed = new URL(value); } catch { throw new Error(`pairing_link_invalid_${label}`); }
    if (parsed.protocol !== "https:") throw new Error(`pairing_link_insecure_${label}`);
  }
  return { secret, nodeId, nodeName, pin, pairUrl, apiBaseUrl };
}

function macKey(secret) {
  return crypto.createHmac("sha256", Buffer.from(String(secret), "utf8")).update(MAC_LABEL).digest();
}

function blobTag(key, slot, blob) {
  return crypto.createHmac("sha256", key)
    .update(Buffer.concat([Buffer.from(slot, "utf8"), Buffer.from([0]), blob]))
    .digest("base64");
}

function verifyBlobTag(key, slot, blob, tag) {
  let actual;
  try { actual = Buffer.from(String(tag || ""), "base64"); } catch { return false; }
  const expected = Buffer.from(blobTag(key, slot, blob), "base64");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function deviceToken(secret) {
  return crypto.createHmac("sha256", Buffer.from(String(secret), "utf8"))
    .update(DEVICE_TOKEN_LABEL)
    .digest("hex");
}

function spkiPin(certificate) {
  const x509 = certificate instanceof crypto.X509Certificate
    ? certificate
    : new crypto.X509Certificate(certificate);
  const spki = x509.publicKey.export({ type: "spki", format: "der" });
  return crypto.createHash("sha256").update(spki).digest("base64url");
}

function peerChainHasPin(peer, wantedPin) {
  const seen = new Set();
  let current = peer;
  while (current?.raw && !seen.has(current.fingerprint256 || current.raw.toString("hex"))) {
    seen.add(current.fingerprint256 || current.raw.toString("hex"));
    try {
      if (spkiPin(current.raw) === wantedPin) return true;
    } catch {
      return false;
    }
    if (!current.issuerCertificate || current.issuerCertificate === current) break;
    current = current.issuerCertificate;
  }
  return false;
}

function collectJsonResponse(res, resolve, reject) {
  let size = 0;
  const chunks = [];
  res.on("data", (chunk) => {
    size += chunk.length;
    if (size > MAX_RESPONSE_BYTES) {
      reject(new Error("direct_response_too_large"));
      res.destroy();
      return;
    }
    chunks.push(chunk);
  });
  res.on("end", () => {
    const text = Buffer.concat(chunks).toString("utf8");
    let json = null;
    try { json = text ? JSON.parse(text) : {}; } catch { /* reported below */ }
    resolve({ status: res.statusCode || 0, json, text });
  });
  res.on("error", reject);
}

function requestJson(urlValue, { method = "GET", headers = {}, body = null, caPem = null } = {}) {
  const url = new URL(urlValue);
  const payload = body === null ? null : Buffer.from(JSON.stringify(body), "utf8");
  const transport = url.protocol === "https:" ? https : http;
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return Promise.reject(new Error("direct_url_protocol_invalid"));
  }
  return new Promise((resolve, reject) => {
    const req = transport.request(url, {
      method,
      ca: caPem || undefined,
      rejectUnauthorized: url.protocol === "https:",
      headers: {
        accept: "application/json",
        ...(payload ? { "content-type": "application/json", "content-length": payload.length } : {}),
        ...headers,
      },
    }, (res) => collectJsonResponse(res, resolve, reject));
    req.on("error", reject);
    req.end(payload || undefined);
  });
}

// The pairing token must not leave the laptop until the live TLS connection
// proves the CA SPKI pin carried in the QR. The socket is verified first and
// then handed to https.request; no request byte is written on an unverified
// connection.
function requestJsonPinned(urlValue, wantedPin, body) {
  const url = new URL(urlValue);
  if (url.protocol !== "https:") return Promise.reject(new Error("pairing_endpoint_requires_https"));
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  return new Promise((resolve, reject) => {
    const agent = new https.Agent({ keepAlive: false });
    agent.createConnection = (options, callback) => {
      const socket = tls.connect({
        host: options.host,
        port: options.port,
        servername: /^[0-9a-f:.]+$/i.test(options.host) ? undefined : options.servername,
        rejectUnauthorized: false,
      });
      let completed = false;
      socket.once("error", (error) => {
        if (!completed) {
          completed = true;
          callback(error);
        }
      });
      socket.once("secureConnect", () => {
        if (completed) return;
        completed = true;
        if (!peerChainHasPin(socket.getPeerCertificate(true), wantedPin)) {
          socket.destroy();
          callback(new Error("pairing_certificate_pin_mismatch"));
          return;
        }
        callback(null, socket);
      });
      return undefined;
    };
    const req = https.request(url, {
      method: "POST",
      agent,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "content-length": payload.length,
      },
    }, (res) => collectJsonResponse(res, resolve, reject));
    req.on("error", reject);
    req.end(payload);
  });
}

function directApiRequest(config, pathname, options = {}) {
  const base = new URL(config.apiBaseUrl);
  const target = new URL(pathname, `${base.toString().replace(/\/$/, "")}/`);
  if (target.origin !== base.origin) return Promise.reject(new Error("direct_api_path_invalid"));
  return requestJson(target, {
    ...options,
    caPem: config.caPem,
    headers: { authorization: `Bearer ${config.deviceToken}`, ...(options.headers || {}) },
  });
}

export {
  DIRECT_CONFIG_VERSION,
  DEVICE_SLOT,
  NODE_SLOT,
  directConfigPath,
  readDirectConfig,
  writeDirectConfig,
  parsePairingLink,
  macKey,
  blobTag,
  verifyBlobTag,
  deviceToken,
  spkiPin,
  peerChainHasPin,
  requestJson,
  requestJsonPinned,
  directApiRequest,
};
