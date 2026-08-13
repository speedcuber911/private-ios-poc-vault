// Grant gateway: verify an Ed25519 browser-grant JWT and reverse-proxy only
// GET /activity/{jobs,threads,events} to the node's real list paths.
//
// JWT verify helpers below are a local copy of the cloud jwt.js shape
// (decode + totality: never throw). Canonical copy: product/cloud/src/jwt.js.
// jwt.js does not yet export verifyEd25519 on this branch; this file implements
// it with node:crypto Ed25519 (alg EdDSA), same contract as the plan.

import { createServer } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createLogger } from "./log.js";

// Confirmed against product/relayd/src/server.mjs routeRequest and
// product/relayd/src/additions.mjs: list routes are /v1/codex/jobs,
// /v1/codex/threads, and /v1/events (not /v1/jobs|/v1/threads).
const ALLOW = {
  "/activity/jobs": "/v1/codex/jobs",
  "/activity/threads": "/v1/codex/threads",
  "/activity/events": "/v1/events",
};

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const B64URL_RE = /^[A-Za-z0-9_-]+$/;

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodePart(part) {
  if (typeof part !== "string" || !B64URL_RE.test(part)) return null;
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  return isPlainObject(parsed) ? parsed : null;
}

function decodeJwtUnsafe(token) {
  if (typeof token !== "string" || token.length === 0) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  if (!B64URL_RE.test(parts[2])) return null;
  const header = decodePart(parts[0]);
  const payload = decodePart(parts[1]);
  if (!header || !payload) return null;
  return { header, payload, parts };
}

function verifyEd25519(token, publicKey, nowMs = Date.now()) {
  try {
    const decoded = decodeJwtUnsafe(token);
    if (!decoded) return null;
    const { header, payload, parts } = decoded;
    if (header.alg !== "EdDSA") return null;
    const sig = Buffer.from(parts[2], "base64url");
    const ok = cryptoVerify(null, Buffer.from(`${parts[0]}.${parts[1]}`), publicKey, sig);
    if (!ok) return null;
    if (
      typeof payload.exp !== "number" ||
      !Number.isFinite(payload.exp) ||
      payload.exp * 1000 <= nowMs
    ) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

function loadPublicKey(value) {
  if (!value) return null;
  if (typeof value === "object" && value.asymmetricKeyType === "ed25519") return value;
  if (typeof value !== "string") return null;
  try {
    const raw = Buffer.from(value, "base64url");
    if (raw.length !== 32) return null;
    return createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
      format: "der",
      type: "spki",
    });
  } catch {
    return null;
  }
}

function bearerToken(req) {
  const header = req.headers.authorization;
  if (typeof header !== "string") return null;
  const match = /^Bearer (.+)$/.exec(header);
  return match ? match[1] : null;
}

// Production node HTTP URL is the existing broker SNI host:
//   https://<node-id><TUNNEL_SUFFIX>   e.g. https://node1.tun.test
// Tests inject NODE_PROXY_TARGET as a single origin (the fake node).
function resolveNodeOrigin(nodeId, { nodeProxyTarget, nodeBaseUrl, tunnelSuffix }) {
  if (typeof nodeProxyTarget === "string" && nodeProxyTarget) {
    return nodeProxyTarget.replace(/\/$/, "");
  }
  if (typeof nodeBaseUrl === "string" && nodeBaseUrl.includes("{node}")) {
    return nodeBaseUrl.replaceAll("{node}", nodeId).replace(/\/$/, "");
  }
  if (typeof tunnelSuffix === "string" && tunnelSuffix) {
    const suffix = tunnelSuffix.startsWith(".") ? tunnelSuffix : `.${tunnelSuffix}`;
    return `https://${nodeId}${suffix}`;
  }
  return null;
}

function send(res, status) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(status === 401 ? '{"error":"unauthorized"}' : '{"error":"forbidden"}');
}

function logSafe(log, event) {
  try {
    log(event);
  } catch {
    // logging must never break the request
  }
}

function proxyGet(target, authorization, res, logEvent) {
  const url = new URL(target);
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;
  const upstream = request(
    {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: "GET",
      headers: {
        authorization,
        host: url.host,
      },
    },
    (upRes) => {
      logEvent(upRes.statusCode);
      const headers = {};
      if (upRes.headers["content-type"]) headers["content-type"] = upRes.headers["content-type"];
      if (upRes.headers["cache-control"]) headers["cache-control"] = upRes.headers["cache-control"];
      res.writeHead(upRes.statusCode, headers);
      upRes.pipe(res);
    },
  );
  upstream.on("error", () => {
    logEvent(502);
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end('{"error":"bad_gateway"}');
    } else {
      res.destroy();
    }
  });
  upstream.end();
}

export function createGateway(options = {}) {
  const grantPublicKey = loadPublicKey(options.grantPublicKey ?? process.env.GRANT_PUBLIC_KEY);
  if (!grantPublicKey) {
    throw new Error("GRANT_PUBLIC_KEY is required");
  }
  const nodeProxyTarget = options.nodeProxyTarget ?? process.env.NODE_PROXY_TARGET;
  const nodeBaseUrl = options.nodeBaseUrl ?? process.env.NODE_BASE_URL;
  const tunnelSuffix = options.tunnelSuffix ?? process.env.TUNNEL_SUFFIX;
  const log = options.log ?? createLogger();
  const now = options.now ?? Date.now;

  return createServer((req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
    const mapped = req.method === "GET" ? ALLOW[url.pathname] : undefined;
    if (!mapped) {
      logSafe(log, { method: req.method, path: url.pathname, status: 403 });
      send(res, 403);
      return;
    }

    const token = bearerToken(req);
    const payload = verifyEd25519(token, grantPublicKey, now());
    if (!payload) {
      logSafe(log, { method: req.method, path: url.pathname, status: 401 });
      send(res, 401);
      return;
    }
    if (typeof payload.node !== "string" || payload.node.length === 0) {
      logSafe(log, { method: req.method, path: url.pathname, status: 403 });
      send(res, 403);
      return;
    }

    const origin = resolveNodeOrigin(payload.node, { nodeProxyTarget, nodeBaseUrl, tunnelSuffix });
    if (!origin) {
      logSafe(log, { method: req.method, path: url.pathname, status: 403, node: payload.node });
      send(res, 403);
      return;
    }

    const target = `${origin}${mapped}${url.search}`;
    proxyGet(target, `Bearer ${token}`, res, (status) => {
      logSafe(log, { method: "GET", path: url.pathname, status, node: payload.node });
    });
  });
}

function isMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  return fileURLToPath(import.meta.url) === entry;
}

if (isMain()) {
  const host = process.env.HOST || "127.0.0.1";
  const port = Number.parseInt(process.env.PORT || "8791", 10);
  if (host !== "127.0.0.1") {
    console.error("grant-gateway listens on 127.0.0.1 only");
    process.exit(1);
  }
  const server = createGateway();
  server.listen(port, host, () => {
    console.error(`grant-gateway listening on ${host}:${port}`);
  });
}
