import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const CAPABILITY_RE = /^\/v1\/codex\/previews\/([A-Za-z0-9_-]{43})\/proxy(?:\/|$)/;
const VIEW_RE = /^\/v1\/codex\/previews\/([A-Za-z0-9_-]{43})\/?$/;
const PROXY_METHODS = new Set(["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"]);
const FORWARDED_REQUEST_HEADERS = new Set([
  "accept",
  "accept-language",
  "cache-control",
  "content-type",
  "if-modified-since",
  "if-none-match",
  "range",
]);
const FORWARDED_RESPONSE_HEADERS = new Set([
  "accept-ranges",
  "content-disposition",
  "content-language",
  "content-range",
  "content-type",
  "etag",
  "last-modified",
]);

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_LEASES = 24;
const DEFAULT_MAX_BODY_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_REWRITE_BYTES = 8 * 1024 * 1024;
const MAX_JOB_OUTPUT_BYTES = 6 * 1024 * 1024;

function createPreviewService({
  jobs,
  relayPort = null,
  appendAudit = () => {},
  now = () => Date.now(),
  ttlMs = DEFAULT_TTL_MS,
  maxLeases = DEFAULT_MAX_LEASES,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
  maxRewriteBytes = DEFAULT_MAX_REWRITE_BYTES,
  randomToken = () => crypto.randomBytes(32).toString("base64url"),
} = {}) {
  if (!jobs || typeof jobs.get !== "function") {
    throw new TypeError("preview service requires a jobs map");
  }

  const leases = new Map();

  function prune() {
    const timestamp = now();
    for (const [token, lease] of leases) {
      if (lease.expiresAtMs <= timestamp) leases.delete(token);
    }
    while (leases.size >= maxLeases) {
      const oldest = leases.keys().next().value;
      if (!oldest) break;
      leases.delete(oldest);
    }
  }

  function capabilityMatch(url) {
    return CAPABILITY_RE.exec(url.pathname);
  }

  function isCapabilityPath(url) {
    return capabilityMatch(url) !== null;
  }

  async function routeCapability(req, res, url) {
    const match = capabilityMatch(url);
    if (!match) return false;

    prune();
    const lease = leases.get(match[1]);
    if (!lease || lease.expiresAtMs <= now()) {
      leases.delete(match[1]);
      sendError(res, 404, "preview not found");
      return true;
    }

    if (!PROXY_METHODS.has(req.method || "")) {
      sendError(res, 404, "preview not found");
      return true;
    }

    await proxyPreviewRequest(req, res, url, lease, {
      maxBodyBytes,
      maxRewriteBytes,
    });
    return true;
  }

  async function routeAuthenticated(req, res, url, auth = {}) {
    if (req.method === "POST" && url.pathname === "/v1/codex/previews") {
      const body = await readJsonBody(req, maxBodyBytes);
      const jobId = typeof body?.jobId === "string" ? body.jobId.trim() : "";
      const sourceURL = typeof body?.url === "string" ? body.url.trim() : "";
      const job = jobId ? jobs.get(jobId) : null;
      if (!job) {
        sendError(res, 404, "job not found");
        return true;
      }

      const target = validatedLoopbackTarget(sourceURL, relayPort);
      if (!target.ok) {
        sendError(res, 400, target.error);
        return true;
      }

      if (!(await jobReferencesURL(job, sourceURL))) {
        sendError(res, 400, "preview URL was not returned by this job");
        return true;
      }

      prune();
      let token = randomToken();
      while (!/^[A-Za-z0-9_-]{43}$/.test(token) || leases.has(token)) token = randomToken();
      const expiresAtMs = now() + ttlMs;
      const lease = {
        token,
        jobId,
        targetOrigin: target.url.origin,
        initialPath: `${target.url.pathname || "/"}${target.url.search}`,
        expiresAtMs,
      };
      leases.set(token, lease);
      appendAudit("preview_lease_created", job, {
        targetPort: target.port,
        expiresAt: new Date(expiresAtMs).toISOString(),
        requestedBy: auth.subject || null,
      });
      sendJson(res, 201, {
        id: token,
        url: `/v1/codex/previews/${token}/`,
        expiresAt: new Date(expiresAtMs).toISOString(),
      });
      return true;
    }

    const viewMatch = VIEW_RE.exec(url.pathname);
    if (viewMatch && req.method === "GET") {
      prune();
      const lease = leases.get(viewMatch[1]);
      if (!lease || lease.expiresAtMs <= now()) {
        leases.delete(viewMatch[1]);
        sendError(res, 404, "preview not found");
        return true;
      }
      sendHtml(res, 200, previewWrapper(lease));
      return true;
    }

    if (viewMatch && req.method === "DELETE") {
      leases.delete(viewMatch[1]);
      res.writeHead(204, { "cache-control": "no-store" });
      res.end();
      return true;
    }

    return false;
  }

  return {
    isCapabilityPath,
    routeCapability,
    routeAuthenticated,
    leaseCount: () => leases.size,
  };
}

function validatedLoopbackTarget(value, relayPort) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, error: "preview URL is invalid" };
  }

  const hostname = url.hostname.toLowerCase();
  if (!LOOPBACK_HOSTS.has(hostname) || (url.protocol !== "http:" && url.protocol !== "https:")) {
    return { ok: false, error: "preview URL must use HTTP on localhost" };
  }
  if (url.username || url.password || url.hash) {
    return { ok: false, error: "preview URL cannot include credentials or a fragment" };
  }

  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === Number(relayPort)) {
    return { ok: false, error: "preview URL must use an unprivileged non-Relay port" };
  }
  return { ok: true, url, port };
}

async function jobReferencesURL(job, sourceURL) {
  const values = [job.result, job.stdout, job.stderr, job.error].filter((value) => typeof value === "string");
  for (const file of [job.resultPath, job.stdoutPath, job.stderrPath]) {
    if (typeof file !== "string" || !file) continue;
    try {
      const bytes = await fs.readFile(file);
      values.push(bytes.subarray(Math.max(0, bytes.length - MAX_JOB_OUTPUT_BYTES)).toString("utf8"));
    } catch {
      // A compact in-memory result is enough; missing logs do not widen access.
    }
  }
  return values.some((value) => value.includes(sourceURL));
}

function previewWrapper(lease) {
  const prefix = `/v1/codex/previews/${lease.token}/proxy`;
  const initial = `${prefix}${lease.initialPath.startsWith("/") ? "" : "/"}${lease.initialPath}`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="referrer" content="no-referrer">
  <title>Relay local preview</title>
  <style>html,body,iframe{width:100%;height:100%;margin:0;border:0;background:#111}body{overflow:hidden}</style>
</head>
<body>
  <iframe
    title="Local preview"
    src="${escapeHtmlAttribute(initial)}"
    sandbox="allow-scripts allow-forms allow-modals"
    referrerpolicy="no-referrer"
  ></iframe>
</body>
</html>`;
}

async function proxyPreviewRequest(req, res, requestURL, lease, { maxBodyBytes, maxRewriteBytes }) {
  const prefix = `/v1/codex/previews/${lease.token}/proxy`;
  const suffix = requestURL.pathname.slice(prefix.length) || "/";
  const target = new URL(lease.targetOrigin);
  target.pathname = suffix.startsWith("/") ? suffix : `/${suffix}`;
  target.search = requestURL.search;

  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  const body = ["GET", "HEAD"].includes(req.method || "")
    ? null
    : await readRawBody(req, maxBodyBytes);
  const headers = {
    host: target.host,
    "accept-encoding": "identity",
    "user-agent": "Relay-local-preview/1",
  };
  for (const [name, value] of Object.entries(req.headers)) {
    if (FORWARDED_REQUEST_HEADERS.has(name.toLowerCase()) && value !== undefined) headers[name] = value;
  }
  if (body) headers["content-length"] = String(body.length);

  const transport = target.protocol === "https:" ? https : http;
  await new Promise((resolve) => {
    const upstream = transport.request(target, { method: req.method, headers }, (upstreamRes) => {
      void forwardPreviewResponse(req, res, upstreamRes, lease, {
        prefix,
        maxRewriteBytes,
      }).then(resolve);
    });
    upstream.setTimeout(15_000, () => upstream.destroy(new Error("preview upstream timed out")));
    upstream.on("error", (error) => {
      if (!res.headersSent) sendError(res, 502, error.message || "preview upstream is unavailable");
      else res.end();
      resolve();
    });
    upstream.end(body || undefined);
  });
}

async function forwardPreviewResponse(req, res, upstream, lease, { prefix, maxRewriteBytes }) {
  const status = upstream.statusCode || 502;
  const contentType = String(upstream.headers["content-type"] || "application/octet-stream");
  const headers = {
    ...corsHeaders(),
    "cache-control": "no-store",
    "content-type": contentType,
    "cross-origin-resource-policy": "cross-origin",
    "referrer-policy": "no-referrer",
  };
  for (const [name, value] of Object.entries(upstream.headers)) {
    if (FORWARDED_RESPONSE_HEADERS.has(name.toLowerCase()) && value !== undefined) headers[name] = value;
  }
  if (upstream.headers.location) {
    headers.location = rewriteLocation(String(upstream.headers.location), lease, prefix);
  }

  if (req.method === "HEAD" || status === 204 || status === 304) {
    res.writeHead(status, headers);
    res.end();
    upstream.resume();
    return;
  }

  if (!isRewriteableContentType(contentType)) {
    if (upstream.headers["content-length"]) headers["content-length"] = upstream.headers["content-length"];
    res.writeHead(status, headers);
    upstream.pipe(res);
    await new Promise((resolve) => {
      upstream.on("end", resolve);
      upstream.on("error", resolve);
      res.on("close", resolve);
    });
    return;
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of upstream) {
    size += chunk.length;
    if (size > maxRewriteBytes) {
      sendError(res, 502, "preview text response is too large");
      return;
    }
    chunks.push(chunk);
  }
  const original = Buffer.concat(chunks).toString("utf8");
  const rewritten = rewritePreviewText(original, contentType, lease, prefix);
  headers["content-length"] = String(Buffer.byteLength(rewritten));
  res.writeHead(status, headers);
  res.end(rewritten);
}

function rewritePreviewText(value, contentType, lease, prefix) {
  const escapedOrigin = escapeRegExp(lease.targetOrigin);
  let rewritten = value.replace(new RegExp(`${escapedOrigin}(?=\\/|["'\\s]|$)`, "gi"), prefix);

  // Static HTML/CSS attributes plus JS/JSON string URLs emitted by Vite, Next,
  // webpack, and similar local dev servers. Relative URLs already resolve under
  // the proxy prefix and are left intact.
  rewritten = rewritten
    .replace(/(\b(?:src|href|action|poster)\s*=\s*["'])\/(?!\/|v1\/codex\/previews\/)/gi, `$1${prefix}/`)
    .replace(/(url\(\s*["']?)\/(?!\/|v1\/codex\/previews\/)/gi, `$1${prefix}/`)
    .replace(/(["'`])\/(?!\/|v1\/codex\/previews\/)/g, `$1${prefix}/`);

  if (/text\/html|application\/xhtml\+xml/i.test(contentType)) {
    const bridge = previewBridgeScript(prefix, lease.targetOrigin);
    rewritten = /<head(?:\s[^>]*)?>/i.test(rewritten)
      ? rewritten.replace(/<head(?:\s[^>]*)?>/i, (match) => `${match}${bridge}`)
      : `${bridge}${rewritten}`;
  }
  return rewritten;
}

function previewBridgeScript(prefix, targetOrigin) {
  const prefixJSON = JSON.stringify(prefix);
  const originJSON = JSON.stringify(targetOrigin);
  return `<script>(function(){
var p=${prefixJSON},o=${originJSON};
function r(v){try{var s=typeof v==='string'?v:v&&v.url;if(!s)return v;if(s.indexOf(o)===0)return p+s.slice(o.length);if(s.charAt(0)==='/'&&s.indexOf(p)!==0)return p+s;return v}catch(_){return v}}
var f=window.fetch;if(f)window.fetch=function(i,n){return f.call(this,r(i),n)};
var xo=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){arguments[1]=r(u);return xo.apply(this,arguments)};
if(window.EventSource){var E=window.EventSource;window.EventSource=function(u,c){return new E(r(u),c)};window.EventSource.prototype=E.prototype}
for(var k of ['pushState','replaceState']){var h=history[k];history[k]=function(s,t,u){return h.call(this,s,t,r(u))}}
document.addEventListener('click',function(e){var a=e.target&&e.target.closest&&e.target.closest('a[href]');if(a)a.href=r(a.getAttribute('href'))},true);
document.addEventListener('submit',function(e){var f=e.target;if(f&&f.getAttribute)f.action=r(f.getAttribute('action')||location.pathname)},true);
})();</script>`;
}

function rewriteLocation(value, lease, prefix) {
  try {
    const target = new URL(value, lease.targetOrigin);
    if (target.origin !== lease.targetOrigin) return value;
    return `${prefix}${target.pathname}${target.search}${target.hash}`;
  } catch {
    return value;
  }
}

function isRewriteableContentType(value) {
  return /^(?:text\/|application\/(?:javascript|json|manifest\+json|x-javascript|xml)|image\/svg\+xml)/i.test(value);
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": [...PROXY_METHODS].join(", "),
    "access-control-allow-headers": "content-type, range, if-none-match, if-modified-since",
    "access-control-expose-headers": "content-type, content-range, accept-ranges, etag, last-modified",
  };
}

function readJsonBody(req, byteLimit) {
  return readRawBody(req, byteLimit).then((body) => {
    if (body.length === 0) return {};
    try {
      return JSON.parse(body.toString("utf8"));
    } catch {
      throw Object.assign(new Error("invalid JSON body"), { status: 400 });
    }
  });
}

function readRawBody(req, byteLimit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > byteLimit) {
        reject(Object.assign(new Error("request body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendHtml(res, status, body) {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": "default-src 'none'; frame-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
    "referrer-policy": "no-referrer",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

function escapeHtmlAttribute(value) {
  return String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export {
  createPreviewService,
  validatedLoopbackTarget,
  rewritePreviewText,
};
