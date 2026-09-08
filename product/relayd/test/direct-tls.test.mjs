// A BYO node, end to end, over the TLS it terminates itself.
//
// The premise of the whole flow is that a phone can reach a machine the user
// owns with nothing but a QR code — no DNS, no reverse proxy, no
// publicly-trusted certificate. That means relayd serves HTTPS in direct mode
// with a leaf signed by its own CA, and the QR carries the pin (`f=`) for that
// CA so the phone's FIRST request — the pairing POST, which carries the token —
// is already protected.
//
// The bare-IP case is the common one for a BYO VM and the one that breaks
// silently: iOS evaluates a pinned chain with SecPolicyCreateSSL(host), which
// checks the host against IP SANs. A DNS SAN holding "192.168.1.20" matches
// nothing, so pairing would fail at the last step with a correct pin. This test
// therefore reaches the node by IP throughout.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const relaydDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const relaydBin = path.join(relaydDir, "bin", "relayd");

function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// A single request with the node CA pinned — the phone's posture, expressed in
// Node. `ca` alone is the point: rejectUnauthorized stays at its default, so a
// chain or hostname failure fails the test rather than being waved through.
function request({ port, method = "GET", pathname, ca, headers = {}, body = null, plain = false }) {
  return new Promise((resolve, reject) => {
    const transport = plain ? http : https;
    // Captured at handshake time: after the response ends the socket may already
    // be back in the agent's pool with nothing to report.
    let peerCertificate = null;
    const req = transport.request(
      { host: "127.0.0.1", port, method, path: pathname, headers, ...(plain ? {} : { ca }) },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode, text, json, peerCertificate });
        });
      },
    );
    req.on("socket", (socket) => {
      socket.on("secureConnect", () => {
        peerCertificate = socket.getPeerCertificate();
      });
    });
    req.on("error", reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

async function waitFor(check, { attempts = 200, delayMs = 100, what }) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const value = await check();
      if (value) return value;
    } catch {
      /* not ready */
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error(`timed out waiting for ${what}`);
}

// The peer half of protocol v2, written out rather than imported: importing
// src/pairing.mjs here would drag in config.mjs with this process's ambient
// environment, and a test of a wire format should compute that format itself.
//   macKey = hmac-sha256(key = token, msg = "relay-pair-mac-v1")
//   tag    = base64( hmac-sha256(macKey, slot || 0x00 || blob) )
function macKeyFor(token) {
  return crypto.createHmac("sha256", Buffer.from(token, "utf8")).update("relay-pair-mac-v1").digest();
}

test("direct mode serves HTTPS the QR pins, and a paired bearer works over it", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-direct-tls-"));
  const workspaceDir = path.join(dir, "scratch");
  fs.mkdirSync(workspaceDir, { recursive: true });
  const apiPort = await freePort();
  const pairPort = await freePort();
  const identityDir = path.join(dir, "identity");

  const env = {
    ...process.env,
    CODEX_API_HOST: "127.0.0.1",
    CODEX_API_PORT: String(apiPort),
    // The node terminates its own TLS — this is the default, pinned here so an
    // ambient value cannot decide what the test is actually exercising.
    RELAYD_DIRECT_TLS: "true",
    // Reached by bare IP, exactly like a BYO VM on a LAN.
    RELAYD_PUBLIC_HOST: "127.0.0.1",
    CODEX_REQUIRE_MTLS: "true",
    CODEX_DATA_DIR: path.join(dir, "data"),
    RELAYD_IDENTITY_DIR: identityDir,
    CODEX_WORKSPACE_BROWSE_ROOT: dir,
    CODEX_WORKSPACES: JSON.stringify([{ id: "scratch", name: "Scratch", path: workspaceDir }]),
    RELAYD_PAIRING_ENABLED: "true",
    RELAYD_PAIRING_HOST: "127.0.0.1",
    RELAYD_PAIRING_PORT: String(pairPort),
  };

  const daemon = spawn(process.execPath, [relaydBin, "run"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  daemon.stdout.setEncoding("utf8");
  daemon.stderr.setEncoding("utf8");
  daemon.stdout.on("data", (chunk) => { output += chunk; });
  daemon.stderr.on("data", (chunk) => { output += chunk; });
  t.after(async () => {
    if (daemon.exitCode === null) {
      daemon.kill("SIGTERM");
      await new Promise((resolve) => daemon.once("exit", resolve));
    }
  });

  const caPath = path.join(identityDir, "ca", "ca.cert.pem");
  await waitFor(() => fs.existsSync(caPath), { what: `the node CA at ${caPath} (daemon: ${output})` });
  const caPem = fs.readFileSync(caPath, "utf8");

  const health = await waitFor(
    async () => {
      const res = await request({ port: apiPort, pathname: "/healthz", ca: caPem });
      return res.status === 200 ? res : null;
    },
    { what: `an HTTPS /healthz on ${apiPort} (daemon: ${output})` },
  );

  // 1. The listener really is TLS, the chain really does terminate in the node
  //    CA, and the leaf really does carry an IP SAN for the advertised host.
  //    Node validated all three to get here; these assertions name them so a
  //    regression says which one broke.
  const leaf = health.peerCertificate;
  assert.ok(leaf && leaf.subjectaltname, "the data listener must serve a certificate");
  assert.match(leaf.subjectaltname, /IP Address:127\.0\.0\.1/, "a bare IP needs an IP SAN, not a DNS SAN");
  assert.equal(leaf.issuer.CN, new crypto.X509Certificate(caPem).subject.split("\n")[0].replace(/^CN=/, ""));

  // Plain HTTP against the same port must not be served.
  await assert.rejects(
    () => request({ port: apiPort, pathname: "/healthz", plain: true }),
    "a TLS listener must not answer cleartext HTTP",
  );

  // 2. `relayd pair` advertises exactly that endpoint, and pins exactly that CA.
  const printed = execFileSync(process.execPath, [relaydBin, "pair", "--no-qr"], {
    encoding: "utf8", env, timeout: 120000,
  });
  const link = /^\s*Link:\s+(\S+)$/m.exec(printed)?.[1];
  assert.ok(link, `no pairing link in output:\n${printed}`);
  const fields = Object.fromEntries(link.split("#")[1].split("&").map((pair) => pair.split("=")));
  const token = fields.t;
  const pairUrl = Buffer.from(fields.p, "base64url").toString("utf8");
  const apiUrl = Buffer.from(fields.a, "base64url").toString("utf8");
  assert.equal(pairUrl, `https://127.0.0.1:${pairPort}/v1/pair`);
  assert.equal(apiUrl, `https://127.0.0.1:${apiPort}`);

  const blobTag = (slot, blob) => crypto
    .createHmac("sha256", macKeyFor(token))
    .update(Buffer.concat([Buffer.from(slot, "utf8"), Buffer.from([0]), blob]))
    .digest("base64");

  const spki = new crypto.X509Certificate(caPem).publicKey.export({ type: "spki", format: "der" });
  assert.equal(fields.f, crypto.createHash("sha256").update(spki).digest("base64url"));

  // 3. Pair over the pairing listener, with the CA from the QR as the only
  //    trust anchor — the bootstrap the `f=` field exists to make safe.
  const deviceBlob = Buffer.from(JSON.stringify({ mint: "p12", deviceName: "Test iPhone", platform: "ios" }), "utf8");
  const paired = await request({
    port: pairPort,
    method: "POST",
    pathname: "/v1/pair",
    ca: caPem,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      v: 2,
      code: token,
      blob: deviceBlob.toString("base64"),
      tag: blobTag("device-blob", deviceBlob),
    }),
  });
  assert.equal(paired.status, 201, `pairing failed: ${paired.text} (daemon: ${output})`);
  const nodeBlob = Buffer.from(paired.json.blob, "base64");
  assert.equal(paired.json.tag, blobTag("node-blob", nodeBlob), "the node blob must be authenticated too");
  const issued = JSON.parse(nodeBlob.toString("utf8"));
  assert.equal(issued.apiBaseUrl, apiUrl);
  // The CA delivered in the blob must hash to the pin that was in the QR.
  const deliveredSpki = new crypto.X509Certificate(issued.caPem).publicKey.export({ type: "spki", format: "der" });
  assert.equal(crypto.createHash("sha256").update(deliveredSpki).digest("base64url"), fields.f);

  // 4. The bearer both sides derive from the same secret now opens the data
  //    listener, over the same pinned TLS.
  const bearerToken = crypto
    .createHmac("sha256", Buffer.from(token, "utf8"))
    .update("relay-device-token-v1")
    .digest("hex");
  const authed = await request({
    port: apiPort,
    pathname: "/v1/codex/health",
    ca: caPem,
    headers: { authorization: `Bearer ${bearerToken}` },
  });
  assert.equal(authed.status, 200, `paired bearer was refused: ${authed.text} (daemon: ${output})`);

  // 5. mTLS is still the rule for a caller with no bearer, on the same node.
  const anonymous = await request({ port: apiPort, pathname: "/v1/codex/health", ca: caPem });
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.json.error, "client certificate is required");

  // 6. And the header path cannot be forged now that this process, not a proxy,
  //    terminates TLS: x-ssl-client-* arriving on the wire is deleted before
  //    anything reads it, and re-derived only from a verified peer certificate.
  const forged = await request({
    port: apiPort,
    pathname: "/v1/codex/health",
    ca: caPem,
    headers: { "x-ssl-client-verify": "SUCCESS", "x-ssl-client-s-dn": "CN=whoever-i-say" },
  });
  assert.equal(forged.status, 401, "forged client-cert headers must never authenticate");
  assert.equal(forged.json.error, "client certificate is required");
});
