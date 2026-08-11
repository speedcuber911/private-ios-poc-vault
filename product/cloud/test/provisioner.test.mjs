import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { loadConfig } from "../src/config.js";
import { createProvisioner } from "../src/provisioner.js";

function startFakeCube(handler) {
  return new Promise((resolve) => {
    const calls = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        calls.push({ method: req.method, url: req.url, apiKey: req.headers["x-api-key"], body: body ? JSON.parse(body) : null });
        handler(req, res, calls.at(-1));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({
        calls,
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

test("createProvisioner returns null when no endpoint is configured", () => {
  const config = loadConfig({});
  assert.equal(createProvisioner(config), null);
});

test("createSandbox posts the E2B create body and returns sandboxId", async () => {
  const fake = await startFakeCube((req, res, call) => {
    res.writeHead(201, { "content-type": "application/json" });
    res.end(JSON.stringify({ sandboxID: "sbx_123", clientID: "c1", templateID: call.body.templateID }));
  });
  try {
    const config = loadConfig({ E2B_API_URL: fake.url, E2B_API_KEY: "k-test", TRIAL_TEMPLATE_ID: "relay-trial" });
    const prov = createProvisioner(config);
    const out = await prov.createSandbox({ envVars: { RELAYD_ENROLL_TOKEN: "t" }, metadata: { trialId: "tr1" } });
    assert.equal(out.sandboxId, "sbx_123");
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0].method, "POST");
    assert.equal(fake.calls[0].url, "/sandboxes");
    assert.equal(fake.calls[0].apiKey, "k-test");
    assert.equal(fake.calls[0].body.templateID, "relay-trial");
    assert.equal(fake.calls[0].body.envVars.RELAYD_ENROLL_TOKEN, "t");
    assert.equal(fake.calls[0].body.metadata.trialId, "tr1");
    assert.equal(typeof fake.calls[0].body.timeout, "number");
  } finally {
    await fake.close();
  }
});

test("killSandbox deletes; 404 is false, 500 throws", async () => {
  let status = 204;
  const fake = await startFakeCube((req, res) => {
    res.writeHead(status);
    res.end();
  });
  try {
    const config = loadConfig({ E2B_API_URL: fake.url, E2B_API_KEY: "k", TRIAL_TEMPLATE_ID: "tpl" });
    const prov = createProvisioner(config);
    assert.equal(await prov.killSandbox("sbx_1"), true);
    assert.equal(fake.calls[0].method, "DELETE");
    assert.equal(fake.calls[0].url, "/sandboxes/sbx_1");
    status = 404;
    assert.equal(await prov.killSandbox("sbx_1"), false);
    status = 500;
    await assert.rejects(() => prov.killSandbox("sbx_1"), /provisioner_http_500/);
  } finally {
    await fake.close();
  }
});

test("pauseSandbox posts pause", async () => {
  const fake = await startFakeCube((req, res) => {
    res.writeHead(204);
    res.end();
  });
  try {
    const config = loadConfig({ E2B_API_URL: fake.url, E2B_API_KEY: "k", TRIAL_TEMPLATE_ID: "tpl" });
    const prov = createProvisioner(config);
    assert.equal(await prov.pauseSandbox("sbx_9"), true);
    assert.equal(fake.calls[0].method, "POST");
    assert.equal(fake.calls[0].url, "/sandboxes/sbx_9/pause");
  } finally {
    await fake.close();
  }
});
