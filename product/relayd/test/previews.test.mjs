import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { createPreviewService, validatedLoopbackTarget } from "../src/previews.mjs";

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

test("creates a job-scoped lease and renders a sandboxed localhost app through it", async (t) => {
  const upstreamRequests = [];
  const upstream = http.createServer((req, res) => {
    upstreamRequests.push({ url: req.url, headers: req.headers });
    if (req.url === "/app/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><html><head><script type="module" src="/app.js"></script></head><body><a href="/next">Next</a><script>fetch('/api')</script></body></html>`);
      return;
    }
    if (req.url === "/app.js") {
      res.writeHead(200, { "content-type": "application/javascript" });
      res.end(`import "/dep.js"; fetch('/api');`);
      return;
    }
    if (req.url === "/api") {
      json(res, 200, { ok: true, next: "/next" });
      return;
    }
    res.writeHead(404).end();
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));

  const sourceURL = `http://127.0.0.1:${upstreamPort}/app/`;
  const jobs = new Map([["job-1", { id: "job-1", result: `Open ${sourceURL}` }]]);
  const service = createPreviewService({ jobs, relayPort: 8787 });
  const relay = http.createServer((req, res) => {
    const url = new URL(req.url, "http://relay.test");
    Promise.resolve().then(async () => {
      if (service.isCapabilityPath(url)) {
        await service.routeCapability(req, res, url);
        return;
      }
      if (req.headers.authorization !== "Bearer device") {
        json(res, 401, { error: "device token is required" });
        return;
      }
      if (await service.routeAuthenticated(req, res, url, { subject: "phone" })) return;
      json(res, 404, { error: "not found" });
    }).catch((error) => json(res, error.status || 500, { error: error.message }));
  });
  const relayPort = await listen(relay);
  t.after(() => close(relay));
  const relayURL = `http://127.0.0.1:${relayPort}`;

  const createdResponse = await fetch(`${relayURL}/v1/codex/previews`, {
    method: "POST",
    headers: { authorization: "Bearer device", "content-type": "application/json" },
    body: JSON.stringify({ jobId: "job-1", url: sourceURL }),
  });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  assert.match(created.id, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(created.url, `/v1/codex/previews/${created.id}/`);

  const blockedWrapper = await fetch(`${relayURL}${created.url}`);
  assert.equal(blockedWrapper.status, 401, "the top-level preview still requires device authentication");

  const wrapperResponse = await fetch(`${relayURL}${created.url}`, {
    headers: { authorization: "Bearer device" },
  });
  assert.equal(wrapperResponse.status, 200);
  const wrapper = await wrapperResponse.text();
  assert.match(wrapper, /sandbox="allow-scripts allow-forms allow-modals"/);
  assert.doesNotMatch(wrapper, /allow-same-origin/);

  const prefix = `/v1/codex/previews/${created.id}/proxy`;
  const pageResponse = await fetch(`${relayURL}${prefix}/app/`);
  assert.equal(pageResponse.status, 200, "iframe assets use the scoped capability without the device bearer token");
  assert.equal(pageResponse.headers.get("access-control-allow-origin"), "*");
  const page = await pageResponse.text();
  assert.match(page, new RegExp(`${prefix.replaceAll("/", "\\/")}\\/app\\.js`));
  assert.match(page, new RegExp(`${prefix.replaceAll("/", "\\/")}\\/next`));
  assert.match(page, /XMLHttpRequest\.prototype\.open/);

  const script = await (await fetch(`${relayURL}${prefix}/app.js`)).text();
  assert.match(script, new RegExp(`${prefix.replaceAll("/", "\\/")}\\/dep\\.js`));
  assert.match(script, new RegExp(`${prefix.replaceAll("/", "\\/")}\\/api`));

  const apiResponse = await fetch(`${relayURL}${prefix}/api`, {
    headers: { authorization: "Bearer must-not-leak", cookie: "relay=session" },
  });
  assert.equal(apiResponse.status, 200);
  assert.deepEqual(await apiResponse.json(), { ok: true, next: `${prefix}/next` });
  const apiRequest = upstreamRequests.find((request) => request.url === "/api");
  assert.equal(apiRequest.headers.authorization, undefined);
  assert.equal(apiRequest.headers.cookie, undefined);
});

test("refuses unreferenced, foreign, privileged, and Relay-loopback preview targets", async (t) => {
  assert.equal(validatedLoopbackTarget("https://example.com:3000", 8787).ok, false);
  assert.equal(validatedLoopbackTarget("http://127.0.0.1:80", 8787).ok, false);
  assert.equal(validatedLoopbackTarget("http://localhost:8787", 8787).ok, false);
  assert.equal(validatedLoopbackTarget("http://[::1]:4317", 8787).ok, true);

  const jobs = new Map([["job-1", { id: "job-1", result: "No preview here." }]]);
  const service = createPreviewService({ jobs, relayPort: 8787 });
  const relay = http.createServer((req, res) => {
    const url = new URL(req.url, "http://relay.test");
    service.routeAuthenticated(req, res, url, { subject: "phone" })
      .then((handled) => { if (!handled) json(res, 404, { error: "not found" }); })
      .catch((error) => json(res, error.status || 500, { error: error.message }));
  });
  const port = await listen(relay);
  t.after(() => close(relay));

  const response = await fetch(`http://127.0.0.1:${port}/v1/codex/previews`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jobId: "job-1", url: "http://localhost:4317" }),
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "preview URL was not returned by this job" });
});

test("expires preview capabilities", async (t) => {
  let timestamp = Date.parse("2026-08-18T00:00:00Z");
  const token = "A".repeat(43);
  const sourceURL = "http://127.0.0.1:4317/";
  const service = createPreviewService({
    jobs: new Map([["job-1", { id: "job-1", result: sourceURL }]]),
    relayPort: 8787,
    ttlMs: 1000,
    now: () => timestamp,
    randomToken: () => token,
  });
  const relay = http.createServer((req, res) => {
    const url = new URL(req.url, "http://relay.test");
    Promise.resolve().then(async () => {
      if (service.isCapabilityPath(url)) return service.routeCapability(req, res, url);
      if (await service.routeAuthenticated(req, res, url, { subject: "phone" })) return;
      json(res, 404, { error: "not found" });
    }).catch((error) => json(res, error.status || 500, { error: error.message }));
  });
  const port = await listen(relay);
  t.after(() => close(relay));

  const created = await fetch(`http://127.0.0.1:${port}/v1/codex/previews`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jobId: "job-1", url: sourceURL }),
  });
  assert.equal(created.status, 201);
  timestamp += 1001;
  const expired = await fetch(`http://127.0.0.1:${port}/v1/codex/previews/${token}/proxy/`);
  assert.equal(expired.status, 404);
  assert.deepEqual(await expired.json(), { error: "preview not found" });
});
