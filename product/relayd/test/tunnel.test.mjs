// W2-MODULES tunnel tests: mux framing units plus a live integration against
// the W1 Go broker (built from product/broker). If the Go toolchain or the
// broker build is unavailable, the integration tests skip and the framing
// units still run.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { test } from "node:test";

const {
  encodeFrame,
  createFrameParser,
  signedPayload,
  signChallenge,
  startTunnelClient,
  startTunnelService,
  subjectDnFromCertificate,
  applyTunnelClientCertHeaders,
  computeBackoffDelay,
  FRAME_DATA,
  FRAME_PING,
  WRITE_CHUNK_BYTES,
} = await import("../src/tunnel.mjs");

const testDir = path.dirname(new URL(import.meta.url).pathname);

const brokerModuleDir = path.resolve(testDir, "..", "..", "broker");

const relaydBin = path.resolve(testDir, "..", "bin", "relayd");

const identityModuleUrl = new URL("../src/identity.mjs", import.meta.url).href;

test("frame codec: roundtrip, incremental parse across chunk boundaries", () => {
  const payload = crypto.randomBytes(70000); // > 1 write chunk
  const frames = [
    encodeFrame(FRAME_PING, 0),
    encodeFrame(FRAME_DATA, 7, payload),
    encodeFrame(FRAME_DATA, 9, Buffer.from("tail")),
  ];
  const wire = Buffer.concat(frames);
  const seen = [];
  const parser = createFrameParser(
    (frame) => seen.push(frame),
    (error) => {
      throw error;
    },
  );
  // Feed one byte at a time across a frame boundary, then the rest in bulk.
  parser.push(wire.subarray(0, 5));
  parser.push(wire.subarray(5, 12));
  parser.push(wire.subarray(12));
  assert.equal(seen.length, 3);
  assert.equal(seen[0].type, FRAME_PING);
  assert.equal(seen[1].streamId, 7);
  assert.ok(seen[1].payload.equals(payload));
  assert.equal(seen[2].payload.toString(), "tail");
});

test("frame codec: oversized frames are rejected", () => {
  const header = Buffer.alloc(9);
  header.writeUInt8(FRAME_DATA, 0);
  header.writeUInt32BE(1, 1);
  header.writeUInt32BE((1 << 20) + 1, 5);
  let error = null;
  const parser = createFrameParser(
    () => {},
    (err) => {
      error = err;
    },
  );
  parser.push(header);
  assert.match(error?.message || "", /oversized frame/);
});

test("challenge signature is domain-separated ed25519 over context||nodeid||challenge", () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const challenge = crypto.randomBytes(32);
  const signature = signChallenge(
    "node1",
    challenge.toString("base64"),
    privateKey.export({ type: "pkcs8", format: "pem" }),
  );
  const ok = crypto.verify(null, signedPayload("node1", challenge), publicKey, Buffer.from(signature, "base64"));
  assert.equal(ok, true);
  // A different node id must not verify (domain separation).
  const wrong = crypto.verify(null, signedPayload("node2", challenge), publicKey, Buffer.from(signature, "base64"));
  assert.equal(wrong, false);
});

// ---------------------------------------------------------------------------
// Forwarded-subject synthesis (spoofing defense)
// ---------------------------------------------------------------------------

function hasOpenssl() {
  try {
    execFileSync("openssl", ["version"], { encoding: "utf8", timeout: 60000 });
    return true;
  } catch {
    return false;
  }
}

function makeSelfSignedCert(dir, name, subject) {
  const keyPath = path.join(dir, `${name}.key.pem`);
  const certPath = path.join(dir, `${name}.cert.pem`);
  execFileSync("openssl", ["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", keyPath]);
  execFileSync("openssl", [
    "req", "-x509", "-new", "-key", keyPath, "-sha256", "-days", "2", "-subj", subject, "-out", certPath,
  ]);
  return { keyPath, certPath };
}

test("subject DN is derived in the same RFC 2253 form the gateway forwards", (t) => {
  if (!hasOpenssl()) {
    t.skip("openssl unavailable — DN derivation test skipped");
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-dn-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  for (const subject of ["/CN=device-1", "/C=US/O=Relay/OU=Devices/CN=device-1", "/CN=weird, name/O=Relay"]) {
    const { certPath } = makeSelfSignedCert(dir, `probe-${crypto.randomUUID()}`, subject);
    // openssl is the oracle: `-nameopt RFC2253` is exactly what nginx puts in
    // $ssl_client_s_dn, which server.authorize() matches against the allowlist.
    const printed = execFileSync("openssl", ["x509", "-in", certPath, "-noout", "-subject", "-nameopt", "RFC2253"], {
      encoding: "utf8",
    });
    const expected = /^subject=(.+)$/m.exec(printed)[1].trim();
    const raw = new crypto.X509Certificate(fs.readFileSync(certPath)).raw;
    assert.equal(subjectDnFromCertificate({ raw }), expected);
  }

  // Anything that is not a parseable certificate is unauthenticated, never
  // a pass-through of caller-controlled data.
  assert.equal(subjectDnFromCertificate(null), null);
  assert.equal(subjectDnFromCertificate(undefined), null);
  assert.equal(subjectDnFromCertificate({}), null);
  assert.equal(subjectDnFromCertificate({ raw: Buffer.alloc(0) }), null);
  assert.equal(subjectDnFromCertificate({ raw: Buffer.from("not-a-certificate") }), null);
  assert.equal(subjectDnFromCertificate({ subject: { CN: "spoofed" } }), null);
});

function fakeRequest({ headers = {}, peerCertificate = null, authorized = true, socket = undefined }) {
  const rawHeaders = [];
  const lowered = {};
  for (const [name, value] of Object.entries(headers)) {
    rawHeaders.push(name, value);
    lowered[name.toLowerCase()] = value;
  }
  return {
    headers: lowered,
    rawHeaders,
    socket:
      socket === undefined
        ? { authorized, getPeerCertificate: () => peerCertificate }
        : socket,
  };
}

test("tunneled requests: client-supplied x-ssl-client-* headers are replaced by cert-derived ones", (t) => {
  if (!hasOpenssl()) {
    t.skip("openssl unavailable — header synthesis test skipped");
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-hdr-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { certPath } = makeSelfSignedCert(dir, "device", "/CN=real-device");
  const raw = new crypto.X509Certificate(fs.readFileSync(certPath)).raw;

  const spoofed = fakeRequest({
    headers: {
      "X-SSL-Client-Verify": "SUCCESS",
      "X-SSL-Client-S-DN": "CN=other-device",
      "X-Ssl-Client-I-Dn": "CN=made up CA",
      "x-ssl-client-cert": "-----BEGIN CERTIFICATE-----",
      "User-Agent": "relay-tests",
    },
    peerCertificate: { raw },
  });
  const subject = applyTunnelClientCertHeaders(spoofed);
  assert.equal(subject, "CN=real-device");
  assert.equal(spoofed.headers["x-ssl-client-s-dn"], "CN=real-device");
  assert.equal(spoofed.headers["x-ssl-client-verify"], "SUCCESS");
  assert.equal(spoofed.headers["x-ssl-client-i-dn"], undefined);
  assert.equal(spoofed.headers["x-ssl-client-cert"], undefined);
  assert.equal(spoofed.headers["user-agent"], "relay-tests");
  // rawHeaders must not keep the forged copies either.
  const rawNames = spoofed.rawHeaders.filter((_, index) => index % 2 === 0).map((name) => name.toLowerCase());
  assert.deepEqual(rawNames, ["user-agent"]);

  // No peer certificate, an unverified handshake, or a non-TLS socket: the
  // headers stay absent so authorize() fails closed.
  for (const request of [
    fakeRequest({ headers: { "x-ssl-client-verify": "SUCCESS", "x-ssl-client-s-dn": "CN=other-device" }, peerCertificate: {} }),
    fakeRequest({ headers: { "x-ssl-client-verify": "SUCCESS", "x-ssl-client-s-dn": "CN=other-device" }, peerCertificate: { raw }, authorized: false }),
    fakeRequest({ headers: { "x-ssl-client-verify": "SUCCESS", "x-ssl-client-s-dn": "CN=other-device" }, socket: {} }),
    fakeRequest({ headers: { "x-ssl-client-verify": "SUCCESS", "x-ssl-client-s-dn": "CN=other-device" }, socket: null }),
  ]) {
    assert.equal(applyTunnelClientCertHeaders(request), null);
    assert.equal(request.headers["x-ssl-client-verify"], undefined);
    assert.equal(request.headers["x-ssl-client-s-dn"], undefined);
  }
});

// ---------------------------------------------------------------------------
// Reconnect supervisor
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Returns the moment the predicate holds. `timeoutMs` is a hang detector, not
// a schedule: nothing here is expected to take anywhere near it, so every
// caller passes a value far above what a stalled machine needs rather than one
// tuned to how long the work "should" take.
const WAIT_DEADLINE_MS = 30000;

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
    await sleep(25);
  }
}

test("backoff doubles, is jittered into [50%, 100%], and is capped", () => {
  const options = { baseMs: 1000, maxMs: 30000 };
  assert.equal(computeBackoffDelay(1, { ...options, random: () => 0 }), 500);
  assert.equal(computeBackoffDelay(1, { ...options, random: () => 1 }), 1000);
  assert.equal(computeBackoffDelay(2, { ...options, random: () => 1 }), 2000);
  assert.equal(computeBackoffDelay(3, { ...options, random: () => 0 }), 2000);
  assert.equal(computeBackoffDelay(20, { ...options, random: () => 1 }), 30000);
  assert.equal(computeBackoffDelay(20, { ...options, random: () => 0 }), 15000);
  // Real jitter stays inside the window and never returns 0.
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const delay = computeBackoffDelay(attempt, options);
    const ceiling = Math.min(30000, 1000 * 2 ** (attempt - 1));
    assert.ok(delay >= ceiling / 2 && delay <= ceiling, `attempt ${attempt} delay ${delay}`);
  }
});

test("tunnel service reconnects after failures, resets backoff, and stops cleanly", async () => {
  const states = [];
  let dials = 0;
  let closes = 0;
  let sessionOnError = null;

  const service = startTunnelService({
    nodeId: "node1",
    backoffBaseMs: 2,
    backoffMaxMs: 4,
    random: () => 1,
    onState: (state, detail) => states.push([state, detail.attempt ?? null]),
    connect: async ({ onError, nodeId }) => {
      assert.equal(nodeId, "node1");
      dials += 1;
      if (dials === 1) throw new Error("broker down");
      sessionOnError = onError;
      return { close: () => { closes += 1; } };
    },
  });

  await waitFor(() => service.state === "registered", WAIT_DEADLINE_MS, "first registration");
  assert.equal(dials, 2);
  assert.equal(service.attempt, 0, "backoff resets on a successful registration");

  // Session drops: the supervisor redials.
  sessionOnError(new Error("tunnel connection closed"));
  await waitFor(() => dials === 3 && service.state === "registered", WAIT_DEADLINE_MS, "reconnect");

  service.stop();
  assert.equal(service.state, "stopped");
  assert.equal(closes, 1, "stop() closes the live session");
  const dialsAtStop = dials;
  await sleep(50);
  assert.equal(dials, dialsAtStop, "no dials after stop()");
  assert.deepEqual(
    states.map(([state]) => state),
    ["connecting", "reconnecting", "connecting", "registered", "reconnecting", "connecting", "registered", "stopped"],
  );
});

test("tunnel service schedules exactly one reconnect when a dial reports failure twice", async () => {
  // startTunnelClient reports a pre-registration failure through BOTH onError
  // and a rejected promise; the supervisor must not double-schedule.
  let dials = 0;
  const started = Date.now();
  const service = startTunnelService({
    backoffBaseMs: 60,
    backoffMaxMs: 60,
    random: () => 1,
    connect: ({ onError }) => {
      dials += 1;
      const error = new Error("tunnel closed before registration");
      onError(error);
      return Promise.reject(error);
    },
  });
  await waitFor(() => dials >= 3, WAIT_DEADLINE_MS, "retries");
  const seen = dials;
  const elapsed = Date.now() - started;
  service.stop();
  await sleep(120);
  assert.equal(dials, seen, "stop() halts the retry loop");
  // One chain at a fixed 60 ms delay: doubled scheduling would double the rate.
  assert.ok(seen <= Math.ceil(elapsed / 60) + 1, `expected one retry chain, saw ${seen} dials in ${elapsed}ms`);
});

// ---------------------------------------------------------------------------
// Integration against the Go broker
// ---------------------------------------------------------------------------

function buildBrokerBinaries(tmpDir) {
  try {
    execFileSync("go", ["build", "-o", path.join(tmpDir, "broker"), "./cmd/broker"], {
      cwd: brokerModuleDir,
      encoding: "utf8",
      timeout: 180000,
    });
    execFileSync("go", ["build", "-o", path.join(tmpDir, "genfixtures"), "./cmd/genfixtures"], {
      cwd: brokerModuleDir,
      encoding: "utf8",
      timeout: 180000,
    });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Broker process control.
//
// Ports come from the BROKER, not from a bind-and-close lottery. Reserving a
// port by listening on :0 and closing it hands that port straight back to the
// kernel: every other process on the machine — including the daemons the rest
// of this suite spawns concurrently — can be handed the same number before the
// broker gets around to binding it, and the loser dies at bind time while the
// test blames whatever else answered on that port. The broker already prints
// the addresses it actually bound, after both listeners are up, so the test
// asks for :0 and reads the answer.
// ---------------------------------------------------------------------------

// Wall-clock ceiling, not synchronization: waiting stops the moment the broker
// reports its listeners. It only exists so a broker that never comes up fails
// loudly, with its log, instead of stalling the run.
const BROKER_READY_DEADLINE_MS = 60000;

function spawnBroker(brokerBin, { passthroughPort = 0, tunnelPort = 0, suffix = null, nodes = [] }) {
  const args = ["-passthrough", `127.0.0.1:${passthroughPort}`, "-tunnel", `127.0.0.1:${tunnelPort}`];
  if (suffix) args.push("-suffix", suffix);
  for (const node of nodes) args.push("-node", node);
  const child = spawn(brokerBin, args, { stdio: ["ignore", "pipe", "pipe"] });
  const broker = { child, log: "", exit: null, args };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => (broker.log += chunk));
  child.stderr.on("data", (chunk) => (broker.log += chunk));
  child.on("exit", (code, signal) => (broker.exit = { code, signal }));
  broker.describe = () =>
    `broker ${JSON.stringify(args)} ${broker.exit ? `EXITED (code=${broker.exit.code} signal=${broker.exit.signal})` : "running"}; ` +
    `log: ${broker.log.trim() || "<no output>"}`;
  return broker;
}

// Waits for `broker up: passthrough=<addr> tunnel=<addr>`, which the broker
// prints only once BOTH net.Listen calls have returned, and races that against
// the child's exit so a failed bind is reported as a failed bind.
async function brokerListeners(broker, label) {
  const started = Date.now();
  for (;;) {
    const match = broker.log.match(/broker up: passthrough=\S*?:(\d+) tunnel=\S*?:(\d+)/);
    if (match) return { passthroughPort: Number(match[1]), tunnelPort: Number(match[2]) };
    if (broker.exit) throw new Error(`${label}: broker never started listening. ${broker.describe()}`);
    if (Date.now() - started > BROKER_READY_DEADLINE_MS) {
      throw new Error(`${label}: broker did not report its listeners in ${Date.now() - started}ms. ${broker.describe()}`);
    }
    await sleep(25);
  }
}

// A stream whose frames are released one at a time BY THE TEST, each only
// after it has seen the previous frame arrive. See the SSE assertion below.
function createTickGate(total) {
  const releases = [];
  const gates = [];
  for (let index = 0; index < total; index += 1) {
    let release;
    gates.push(new Promise((resolve) => {
      release = resolve;
    }));
    releases.push(release);
  }
  return {
    total,
    wait: (index) => gates[index],
    release: (index) => releases[index]?.(),
    releaseAll: () => releases.forEach((release) => release()),
  };
}

async function setupBrokerAndClient(t) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-tunnel-test-"));
  if (!buildBrokerBinaries(tmpDir)) {
    t.skip("go toolchain unavailable or broker build failed — integration skipped");
    return null;
  }
  const fixturesDir = path.join(tmpDir, "fixtures");
  execFileSync(path.join(tmpDir, "genfixtures"), ["-out", fixturesDir], { encoding: "utf8" });

  const broker = spawnBroker(path.join(tmpDir, "broker"), {
    nodes: [`node1=${path.join(fixturesDir, "node1-identity-pub.pem")}`],
  });
  // Register cleanup FIRST so a failed dial never leaks the broker child.
  let client = null;
  const ticks = createTickGate(5);
  t.after(() => {
    ticks.releaseAll();
    client?.close();
    broker.child.kill("SIGTERM");
  });

  const { passthroughPort, tunnelPort } = await brokerListeners(broker, "broker+node integration");

  const read = (name) => fs.readFileSync(path.join(fixturesDir, name), "utf8");
  const revoked = new Set();
  client = await dialNode({
    brokerHost: "127.0.0.1",
    brokerPort: tunnelPort,
    nodeId: "node1",
    identityKeyPem: read("node1-identity.pem"),
    tlsCertPem: read("node1-tls-cert.pem"),
    tlsKeyPem: read("node1-tls-key.pem"),
    deviceCaPem: read("device-ca.pem"),
    isRevokedSerial: (serial) => revoked.has(serial),
    handler: (req, res) => {
      if (req.url === "/healthz") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ok");
        return;
      }
      if (req.url === "/v1/test/stream") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache, no-transform",
        });
        // Tick n+1 is written only after the client has told us it received
        // tick n. Nothing here is on a timer.
        (async () => {
          for (let n = 1; n <= ticks.total; n += 1) {
            // Teardown releases every gate at once, so this loop can resume
            // after the connection is gone; never write to a dead response.
            if (res.destroyed || res.writableEnded) return;
            res.write(`event: tick\ndata: {"n":${n}}\n\n`);
            if (n < ticks.total) await ticks.wait(n - 1);
          }
          res.end();
        })();
        return;
      }
      res.writeHead(404);
      res.end();
    },
  });

  // Reports what actually happened when the dial fails: a bare
  // "tunnel connection closed" from the client says nothing about whether the
  // broker was even alive, and cost real time the last time it appeared.
  async function dialNode(options) {
    const startedAt = Date.now();
    try {
      return await startTunnelClient(options);
    } catch (error) {
      throw new Error(
        `tunnel dial to 127.0.0.1:${tunnelPort} failed after ${Date.now() - startedAt}ms: ${error.message}. ${broker.describe()}`,
        { cause: error },
      );
    }
  }

  return { passthroughPort, fixturesDir, read, revoked, ticks };
}

// `onText` is called after every socket read with everything received so far,
// which is how a test can react to the stream while it is still open.
function tlsRequest({
  port,
  read,
  rawPath,
  withClientCert = true,
  servername = "node1.tun.test",
  onText = null,
  idleMs = 30000,
}) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host: "127.0.0.1",
      port,
      servername,
      ca: read("node-ca.pem"),
      ...(withClientCert ? { cert: read("device-cert.pem"), key: read("device-key.pem") } : {}),
    });
    const chunks = [];
    let text = "";
    socket.on("secureConnect", () => {
      socket.write(`GET ${rawPath} HTTP/1.1\r\nHost: ${servername}\r\nConnection: close\r\n\r\n`);
    });
    socket.on("data", (chunk) => {
      chunks.push(chunk);
      text += chunk.toString("utf8");
      if (onText) {
        try {
          onText(text);
        } catch (error) {
          socket.destroy();
          reject(error);
        }
      }
    });
    socket.on("end", () => resolve({ text: Buffer.concat(chunks).toString("utf8"), reads: chunks.length }));
    socket.on("error", reject);
    // For requests that must be SERVED this ceiling is not synchronization —
    // it only turns a stream that never advances into a named failure. For the
    // "must never be served" probes it is the mechanism, because the node
    // drops those connections without telling the peer (see the note on the
    // revocation test); the error carries whatever did arrive so the caller
    // can assert on it.
    socket.setTimeout(idleMs, () => {
      socket.destroy();
      const error = new Error(
        `tls request to ${rawPath} received nothing for ${idleMs}ms (${chunks.length} reads so far)`,
      );
      error.received = text;
      error.reads = chunks.length;
      reject(error);
    });
  });
}

test("integration: mTLS request through the Go broker reaches the node handler", async (t) => {
  const setup = await setupBrokerAndClient(t);
  if (!setup) return;
  const { passthroughPort, read, ticks } = setup;
  const { text } = await tlsRequest({ port: passthroughPort, read, rawPath: "/healthz" });
  assert.match(text, /HTTP\/1\.1 200/);
  // Body arrives chunked: "2\r\nok\r\n0\r\n\r\n".
  assert.match(text, /\r\n2\r\nok\r\n0\r\n/);

  // SSE stays incremental through broker + mux + node TLS. The handler writes
  // tick n+1 only after this reader has SEEN tick n, so the response can only
  // complete if every tick was delivered on its own — anything that buffered
  // the stream deadlocks and fails on the request's inactivity ceiling. That
  // replaces the old wall-clock span check, which measured how stalled the
  // machine was rather than what the tunnel did.
  const observed = [];
  const sse = await tlsRequest({
    port: passthroughPort,
    read,
    rawPath: "/v1/test/stream",
    onText: (soFar) => {
      const seen = (soFar.match(/event: tick/g) || []).length;
      while (observed.length < seen) {
        observed.push(observed.length + 1);
        ticks.release(observed.length - 1);
      }
    },
  });
  assert.deepEqual(observed, [1, 2, 3, 4, 5]);
  assert.equal((sse.text.match(/event: tick/g) || []).length, 5);
  // Each tick had to arrive in its own read: the next one was not written
  // until this reader had already consumed the previous one.
  assert.ok(sse.reads >= 5, `expected at least one socket read per tick, saw ${sse.reads}`);

  // Missing device cert → the node kills the connection; the client either
  // errors or the socket closes without ever seeing an HTTP response.
  const noCert = await tlsRequest({ port: passthroughPort, read, rawPath: "/healthz", withClientCert: false })
    .then((result) => result, (error) => ({ error }));
  assert.ok(
    noCert.error || !/HTTP\/1\.1 200/.test(noCert.text),
    `request without a device cert must never be served: ${JSON.stringify(noCert.text || String(noCert.error))}`,
  );

  // Unknown SNI → broker closes the connection during the handshake.
  const ghost = await tlsRequest({ port: passthroughPort, read, rawPath: "/healthz", servername: "ghost.tun.test" })
    .then((result) => result, (error) => ({ error }));
  assert.ok(
    ghost.error || !/HTTP\/1\.1 200/.test(ghost.text),
    `unroutable SNI must never be served: ${JSON.stringify(ghost.text || String(ghost.error))}`,
  );
});

// ---------------------------------------------------------------------------
// Integration: relayd itself in tunneled listen mode (real broker, real
// identity/CA, real router) — the W2 "two listen modes" item.
// ---------------------------------------------------------------------------

// Device key + CSR, exactly what a phone sends through pairing.
function makeDeviceCsr(dir, name) {
  const keyPath = path.join(dir, `${name}.key.pem`);
  const csrPath = path.join(dir, `${name}.csr.pem`);
  execFileSync("openssl", ["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", keyPath]);
  execFileSync("openssl", ["req", "-new", "-key", keyPath, "-subj", `/CN=${name}`, "-out", csrPath]);
  return { name, keyPath, csrPath };
}

// Runs the REAL identity module in a child process (its config is read from
// env at import time) to create the node identity/CA and issue device certs.
function enrollDevices(env, requests) {
  const script = [
    `const fs = await import("node:fs");`,
    `const identity = await import(${JSON.stringify(identityModuleUrl)});`,
    `identity.initIdentity();`,
    `const requested = JSON.parse(process.env.RELAY_TEST_ENROLL);`,
    `const issued = requested.map((request) => {`,
    `  const result = identity.issueDeviceCert({`,
    `    csrPem: fs.readFileSync(request.csrPath, "utf8"),`,
    `    deviceName: request.name,`,
    `    platform: "cli",`,
    `  });`,
    `  return {`,
    `    name: request.name,`,
    `    deviceId: result.deviceId,`,
    `    certSerial: result.certSerial,`,
    `    certSubject: result.device.certSubject,`,
    `    certificatePem: result.certificatePem,`,
    `  };`,
    `});`,
    `process.stdout.write(JSON.stringify({ nodeId: identity.readNodeId(), caPem: identity.getCaPem(), issued }));`,
  ].join("\n");
  const stdout = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    timeout: 120000,
    env: { ...env, RELAY_TEST_ENROLL: JSON.stringify(requests) },
  });
  return JSON.parse(stdout);
}

// One HTTPS request straight at the broker's passthrough port. TLS terminates
// on the node, so this is the phone's exact code path.
function tunnelRequest({ port, sni, ca, cert, key, pathname, headers = {} }) {
  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        host: "127.0.0.1",
        port,
        servername: sni,
        ca,
        ...(cert ? { cert, key } : {}),
        path: pathname,
        method: "GET",
        headers: { host: sni, connection: "close", ...headers },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }
          resolve({ status: response.statusCode, text, json });
        });
      },
    );
    request.on("error", reject);
    // Hang detector, not a schedule: a warm local request through the broker
    // answers in milliseconds, so this only fires when something is stuck.
    request.setTimeout(30000, () =>
      request.destroy(new Error(`tunnel request to ${pathname} received nothing for 30000ms`)),
    );
    request.end();
  });
}

async function setupTunneledRelayd(t) {
  if (!hasOpenssl()) {
    t.skip("openssl unavailable — tunneled relayd integration skipped");
    return null;
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-tunneled-test-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  if (!buildBrokerBinaries(tmpDir)) {
    t.skip("go toolchain unavailable or broker build failed — integration skipped");
    return null;
  }

  const dataDir = path.join(tmpDir, "data");
  const identityDir = path.join(dataDir, "identity");
  const workspaceRoot = path.join(tmpDir, "workspaces");
  fs.mkdirSync(path.join(workspaceRoot, "scratch"), { recursive: true });
  const certDir = path.join(tmpDir, "devices");
  fs.mkdirSync(certDir, { recursive: true });

  const baseEnv = {
    ...process.env,
    CODEX_DATA_DIR: dataDir,
    RELAYD_IDENTITY_DIR: identityDir,
    CODEX_WORKSPACE_BROWSE_ROOT: workspaceRoot,
    CODEX_WORKSPACES: JSON.stringify([{ id: "scratch", name: "Scratch", path: path.join(workspaceRoot, "scratch") }]),
    CODEX_PROXY_BASE_URL: "",
    CODEX_REMOTE_BASE_URL: "",
    CLAUDE_AWS_PROFILE: "",
    CLAUDE_AWS_REGION: "",
    AWS_REGION: "",
    AWS_DEFAULT_REGION: "",
    CLAUDE_DEFAULT_MODEL: "",
    CLAUDE_SONNET_MODEL: "",
  };

  // a + b are allowlisted; c is enrolled but NOT allowlisted.
  const deviceNames = ["relay-test-device-a", "relay-test-device-b", "relay-test-device-c"];
  const enrollment = enrollDevices(baseEnv, deviceNames.map((name) => makeDeviceCsr(certDir, name)));
  const caPath = path.join(certDir, "node-ca.pem");
  fs.writeFileSync(caPath, enrollment.caPem);
  const certs = new Map();
  for (const issued of enrollment.issued) {
    const certPath = path.join(certDir, `${issued.name}.cert.pem`);
    fs.writeFileSync(certPath, issued.certificatePem);
    certs.set(issued.name.slice(-1), { certPath, keyPath: path.join(certDir, `${issued.name}.key.pem`) });
  }

  const nodeId = enrollment.nodeId;
  const sni = `${nodeId}.tun.test`;
  let broker = null;
  function startBroker(ports) {
    return spawnBroker(path.join(tmpDir, "broker"), {
      ...ports,
      suffix: ".tun.test",
      nodes: [`${nodeId}=${path.join(identityDir, "node-identity.pub.pem")}`],
    });
  }

  let relayd = null;
  let relaydLog = "";
  let relaydExit = null;

  t.after(async () => {
    await stopRelayd();
    broker?.child.kill("SIGKILL");
  });

  broker = startBroker({});
  const { passthroughPort, tunnelPort } = await brokerListeners(broker, "tunneled relayd broker");

  relayd = spawn(
    process.execPath,
    [relaydBin, "run", "--mode", "tunneled"],
    {
      cwd: testDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...baseEnv,
        RELAYD_TUNNEL_HOST: "127.0.0.1",
        RELAYD_TUNNEL_PORT: String(tunnelPort),
        RELAYD_TUNNEL_SUFFIX: ".tun.test",
        RELAYD_TUNNEL_BACKOFF_MS: "100",
        RELAYD_TUNNEL_BACKOFF_MAX_MS: "500",
        CODEX_REQUIRE_MTLS: "true",
        CODEX_ALLOWED_CERT_SUBJECTS: "CN=relay-test-device-a,CN=relay-test-device-b",
      },
    },
  );
  relayd.stdout.on("data", (chunk) => (relaydLog += chunk));
  relayd.stderr.on("data", (chunk) => (relaydLog += chunk));
  relayd.on("exit", (code, signal) => (relaydExit = { code, signal }));

  async function stopRelayd() {
    if (!relayd || relaydExit) return relaydExit;
    relayd.kill("SIGTERM");
    await waitFor(() => relaydExit, WAIT_DEADLINE_MS, "relayd exit").catch(() => {
      relayd.kill("SIGKILL");
    });
    return relaydExit;
  }

  const ca = fs.readFileSync(caPath);
  function get({ device, pathname, headers }) {
    const material = device ? certs.get(device) : null;
    return tunnelRequest({
      port: passthroughPort,
      sni,
      ca,
      cert: material ? fs.readFileSync(material.certPath) : null,
      key: material ? fs.readFileSync(material.keyPath) : null,
      pathname,
      headers,
    });
  }

  async function waitUntilServing(timeoutMs) {
    await waitFor(
      async () => {
        if (relaydExit) throw new Error(`relayd exited (${JSON.stringify(relaydExit)}): ${relaydLog}`);
        try {
          const response = await get({ device: "a", pathname: "/healthz" });
          return response.status === 200;
        } catch {
          return false;
        }
      },
      timeoutMs,
      `tunneled relayd to serve (relayd log: ${relaydLog}) (${broker.describe()})`,
    );
  }

  await waitUntilServing(45000);

  return {
    get,
    waitUntilServing,
    stopRelayd,
    nodeId,
    sni,
    logs: () => ({ relayd: relaydLog, broker: broker.log }),
    async restartBroker() {
      const previous = broker;
      const exited = new Promise((resolve) => previous.child.once("exit", resolve));
      previous.child.kill("SIGKILL");
      await exited;
      // relayd is already configured with these ports, so the replacement has
      // to land on exactly them. A broker that cannot rebind says so here
      // instead of leaving the node redialling a port nothing is listening on.
      broker = startBroker({ passthroughPort, tunnelPort });
      const rebound = await brokerListeners(broker, "restarted broker");
      assert.deepEqual(
        rebound,
        { passthroughPort, tunnelPort },
        `restarted broker bound different ports: ${broker.describe()}`,
      );
    },
  };
}

function callerName(payload) {
  const caller = (payload?.devices || []).filter((device) => device.isCaller);
  assert.equal(caller.length, 1, `exactly one device must be attributed as the caller: ${JSON.stringify(payload)}`);
  return caller[0].name;
}

test("integration: tunneled listen mode serves the real router with cert-derived subjects", async (t) => {
  const setup = await setupTunneledRelayd(t);
  if (!setup) return;

  // Public route (no authorize()).
  const health = await setup.get({ device: "a", pathname: "/healthz" });
  assert.equal(health.status, 200);
  assert.equal(health.json.ok, true);
  assert.equal(health.json.authenticated, false);

  // authorize()-gated route.
  const gated = await setup.get({ device: "a", pathname: "/v1/codex/health" });
  assert.equal(gated.status, 200);
  assert.equal(gated.json.authenticated, true);
  assert.equal(gated.json.requireMtls, true);

  // Subject attribution: /v1/devices marks the calling device via its DN.
  const asA = await setup.get({ device: "a", pathname: "/v1/devices" });
  assert.equal(asA.status, 200);
  assert.equal(callerName(asA.json), "relay-test-device-a");
  const asB = await setup.get({ device: "b", pathname: "/v1/devices" });
  assert.equal(asB.status, 200);
  assert.equal(callerName(asB.json), "relay-test-device-b");

  // Enrolled but not in CODEX_ALLOWED_CERT_SUBJECTS.
  const asC = await setup.get({ device: "c", pathname: "/v1/devices" });
  assert.equal(asC.status, 403);

  // No client certificate: the node requires one, so TLS never completes.
  const noCert = await setup.get({ device: null, pathname: "/healthz" }).then(
    (result) => result,
    (error) => ({ error }),
  );
  assert.ok(
    noCert.error,
    `request without a device cert must never be served: ${JSON.stringify(noCert.text || null)}`,
  );

  // SIGTERM closes the tunnel and exits cleanly.
  const exit = await setup.stopRelayd();
  assert.equal(exit.code, 0, `relayd should exit 0 on SIGTERM: ${JSON.stringify(exit)} ${setup.logs().relayd}`);
  assert.match(setup.logs().relayd, /relayd tunnel registered/);
});

test("integration: forged x-ssl-client-* headers cannot impersonate another device", async (t) => {
  const setup = await setupTunneledRelayd(t);
  if (!setup) return;

  // Device A claims to be device B. The cert wins.
  const spoofB = await setup.get({
    device: "a",
    pathname: "/v1/devices",
    headers: {
      "x-ssl-client-verify": "SUCCESS",
      "x-ssl-client-s-dn": "CN=relay-test-device-b",
    },
  });
  assert.equal(spoofB.status, 200);
  assert.equal(callerName(spoofB.json), "relay-test-device-a");
  assert.equal(
    spoofB.json.devices.find((device) => device.name === "relay-test-device-b").isCaller,
    false,
  );

  // Same with unusual header casing and an extra forged x-ssl-client-* header.
  const spoofOddCase = await setup.get({
    device: "b",
    pathname: "/v1/devices",
    headers: {
      "X-SSL-CLIENT-VERIFY": "SUCCESS",
      "X-Ssl-Client-S-Dn": "CN=relay-test-device-a",
      "X-SSL-Client-I-DN": "CN=Relay Node CA <forged>",
    },
  });
  assert.equal(spoofOddCase.status, 200);
  assert.equal(callerName(spoofOddCase.json), "relay-test-device-b");

  // Privilege escalation attempt: device C is enrolled but not allowlisted;
  // claiming an allowlisted DN must not get it past authorize().
  for (const headers of [
    { "x-ssl-client-verify": "SUCCESS", "x-ssl-client-s-dn": "CN=relay-test-device-a" },
    { "X-SSL-Client-Verify": "SUCCESS", "X-SSL-Client-S-DN": "CN=relay-test-device-a" },
  ]) {
    const escalate = await setup.get({ device: "c", pathname: "/v1/devices", headers });
    assert.equal(escalate.status, 403, `forged subject must not authorize device c: ${escalate.text}`);
  }

  // A forged subject that is not enrolled at all is simply ignored.
  const ghost = await setup.get({
    device: "a",
    pathname: "/v1/codex/health",
    headers: { "x-ssl-client-verify": "SUCCESS", "x-ssl-client-s-dn": "CN=ghost-device" },
  });
  assert.equal(ghost.status, 200);
  assert.equal(ghost.json.authenticated, true);
});

test("integration: the node re-registers after the broker restarts", async (t) => {
  const setup = await setupTunneledRelayd(t);
  if (!setup) return;

  assert.equal((await setup.get({ device: "a", pathname: "/healthz" })).status, 200);

  await setup.restartBroker();
  await setup.waitUntilServing(45000);

  const after = await setup.get({ device: "a", pathname: "/v1/codex/health" });
  assert.equal(after.status, 200);
  assert.equal(after.json.authenticated, true);
  const log = setup.logs().relayd;
  assert.match(log, /relayd tunnel reconnecting/);
  assert.ok(
    (log.match(/relayd tunnel registered/g) || []).length >= 2,
    `expected a second registration after the broker restart: ${log}`,
  );
});

test("integration: revoked device serials are rejected after handshake", async (t) => {
  const setup = await setupBrokerAndClient(t);
  if (!setup) return;
  const { passthroughPort, read, revoked } = setup;

  // Baseline: the device cert works before revocation.
  const before = await tlsRequest({ port: passthroughPort, read, rawPath: "/healthz" });
  assert.match(before.text, /HTTP\/1\.1 200/);

  // Learn the device cert serial, then revoke it.
  const cert = new crypto.X509Certificate(read("device-cert.pem"));
  revoked.add(cert.serialNumber.toUpperCase());

  // The node closes a revoked device's TLS socket without an error, and
  // MuxStream._destroy only emits a RST frame when it is destroyed WITH one
  // (src/tunnel.mjs:149) — so nothing tells the broker or the phone that the
  // stream is gone and this connection simply goes quiet. There is therefore
  // no event to observe: the ceiling below IS the observation. It is safe as
  // one, because the assertion is about ABSENCE — a response that arrived
  // later would make this pass vacuously, never flake — and it is two orders
  // of magnitude above the latency of the identical request that succeeded a
  // few lines up.
  const after = await tlsRequest({ port: passthroughPort, read, rawPath: "/healthz", idleMs: 5000 })
    .then((result) => result, (error) => ({ error }));
  assert.ok(
    after.error || !/HTTP\/1\.1 200/.test(after.text),
    `revoked device cert must never be served: ${JSON.stringify(after.text || String(after.error))}`,
  );
  // Stronger than "no 200": a revoked device gets no response bytes at all.
  assert.equal(
    after.error?.received ?? after.text ?? "",
    "",
    `revoked device cert must receive nothing after the handshake: ${JSON.stringify(after.error?.received ?? after.text)}`,
  );
});
