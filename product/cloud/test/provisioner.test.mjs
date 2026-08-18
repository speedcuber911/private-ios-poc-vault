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

// The E2B/Cube `timeout` field is in SECONDS: CubeAPI forwards it unconverted
// and CubeMaster builds `context.WithTimeout(ctx, timeout * time.Second)`.
// Sending the old millisecond value asked for ~41 days, so the platform-level
// auto-kill — the one backstop that reaps a sandbox whose row lost its id —
// could never fire inside the trial's own 10-day window.
test("createSandbox sends the sandbox timeout in seconds, derived from the trial lifecycle", async () => {
  const fake = await startFakeCube((req, res) => {
    res.writeHead(201, { "content-type": "application/json" });
    res.end(JSON.stringify({ sandboxID: "sbx_1" }));
  });
  try {
    const config = loadConfig({
      E2B_API_URL: fake.url,
      E2B_API_KEY: "k",
      TRIAL_TEMPLATE_ID: "tpl",
      TRIAL_TTL_SEC: "600",
      TRIAL_GRACE_SEC: "300",
    });
    await createProvisioner(config).createSandbox({});
    // ttl + grace + a margin for the reaper to act first. Crucially it is
    // GREATER than ttl + grace: the platform timer is the backstop for
    // orphans, never the thing that kills a trial the reaper still owns.
    assert.equal(fake.calls[0].body.timeout, 600 + 300 + 3600);
    assert.ok(
      fake.calls[0].body.timeout > 600 + 300,
      "the platform timer must outlive Relay's own destroy point",
    );
  } finally {
    await fake.close();
  }
});

test("the default sandbox timeout covers the full default trial lifecycle", async () => {
  // A naive milliseconds→seconds conversion of the old 1-hour constant would
  // yield 3600 and destroy every trial machine an hour after signup — wrong by
  // 168x against the 7-day TTL.
  const config = loadConfig({ E2B_API_URL: "http://cube.invalid", E2B_API_KEY: "k", TRIAL_TEMPLATE_ID: "t" });
  assert.equal(config.trial.sandboxTimeoutSec, 7 * 24 * 3600 + 3 * 24 * 3600 + 3600);
  assert.ok(config.trial.sandboxTimeoutSec > config.trial.ttlSec + config.trial.graceSec);
});

test("the sandbox timeout can never be absent or zero", async () => {
  // Cube treats an absent or zero `timeout` as its own 60-second default — a
  // trial machine that dies a minute after the user signs up.
  const config = loadConfig({
    E2B_API_URL: "http://cube.invalid",
    E2B_API_KEY: "k",
    TRIAL_TEMPLATE_ID: "t",
    TRIAL_SANDBOX_TIMEOUT_SEC: "0",
  });
  assert.ok(config.trial.sandboxTimeoutSec >= 60);

  // And an unusable value is a create failure rather than a short-lived box.
  const broken = loadConfig({ E2B_API_URL: "http://cube.invalid", E2B_API_KEY: "k", TRIAL_TEMPLATE_ID: "t" });
  broken.trial.sandboxTimeoutSec = 0;
  await assert.rejects(
    () => createProvisioner(broken).createSandbox({}),
    /provisioner_invalid_timeout/,
  );
});

// A create response we cannot read an id from means a live sandbox no row can
// reference: updateTrial's `!== undefined` filter silently skips an undefined
// sandboxId, and the reaper only acts on trials that have one.
test("createSandbox rejects a response with no usable sandbox id", async () => {
  let body = {};
  const fake = await startFakeCube((req, res) => {
    res.writeHead(201, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  try {
    const config = loadConfig({ E2B_API_URL: fake.url, E2B_API_KEY: "k", TRIAL_TEMPLATE_ID: "tpl" });
    const prov = createProvisioner(config);
    await assert.rejects(() => prov.createSandbox({}), /provisioner_missing_sandbox_id/);
    body = { sandboxID: "   " };
    await assert.rejects(() => prov.createSandbox({}), /provisioner_missing_sandbox_id/);
    body = { sandboxID: 12345 };
    await assert.rejects(() => prov.createSandbox({}), /provisioner_missing_sandbox_id/);
  } finally {
    await fake.close();
  }
});

// Node's fetch has NO default timeout. Without a bound, a Cube host that
// accepts the connection and then goes quiet hangs the caller forever — which
// inside sweepTrials means the reaper never reaches the next trial and no
// later pass ever runs, with nothing to detect it.
test("provisioner calls are bounded and a hung host does not hang the caller", async () => {
  const pending = [];
  const fake = await startFakeCube((req, res) => {
    pending.push(res); // accept, then never respond
  });
  try {
    const config = loadConfig({
      E2B_API_URL: fake.url,
      E2B_API_KEY: "k",
      TRIAL_TEMPLATE_ID: "tpl",
      TRIAL_PROVISIONER_TIMEOUT_MS: "250",
    });
    const prov = createProvisioner(config);
    const startedAt = Date.now();
    await assert.rejects(() => prov.killSandbox("sbx_hung"));
    assert.ok(
      Date.now() - startedAt < 5000,
      "the call must abort on its own timeout rather than hanging",
    );
  } finally {
    for (const res of pending) res.end();
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

test("paid lifecycle calls extend and resume with the hosted timeout", async () => {
  const fake = await startFakeCube((req, res) => {
    if (req.url.endsWith("/connect")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ sandboxID: "sbx_9" }));
      return;
    }
    res.writeHead(204);
    res.end();
  });
  try {
    const config = loadConfig({
      E2B_API_URL: fake.url,
      E2B_API_KEY: "k",
      TRIAL_TEMPLATE_ID: "tpl",
      HOSTED_SANDBOX_TIMEOUT_SEC: "2678400",
    });
    const provisioner = createProvisioner(config);
    assert.equal(await provisioner.extendSandbox("sbx_9"), true);
    assert.equal(fake.calls[0].url, "/sandboxes/sbx_9/timeout");
    assert.deepEqual(fake.calls[0].body, { timeout: 2678400 });

    assert.equal(await provisioner.resumeSandbox("sbx_9"), true);
    assert.equal(fake.calls[1].url, "/sandboxes/sbx_9/connect");
    assert.deepEqual(fake.calls[1].body, { timeout: 2678400 });
  } finally {
    await fake.close();
  }
});
