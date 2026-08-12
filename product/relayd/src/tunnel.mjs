// relayd tunnel.mjs — W2-MODULES: Node-stdlib tunnel client for the W1 broker
// (product/broker/README.md protocol, verbatim):
//
//   1. Registration (plain TCP): 4-byte BE length-prefixed JSON.
//        broker → node {"v":1,"challenge":"<base64 32B>"}
//        node → broker {"v":1,"node_id":"…","sig":"<base64 ed25519>"}
//        broker → node {"v":1,"ok":true}
//      Signature covers "relay-tunnel-auth-v1" || 0x00 || node_id || 0x00 ||
//      challenge (raw bytes) — the node identity key signs nothing else.
//   2. Mux framing: 9-byte header (type u8, stream id u32 BE, length u32 BE)
//      then payload. SYN=1 DATA=2 FIN=3 RST=4 PING=5 PONG=6. Writes chunked
//      at 32 KiB; frames capped at 1 MiB on read. Broker opens streams (odd
//      ids); the node never opens streams.
//   3. Each inbound logical stream carries one TLS session terminated HERE
//      (node cert + REQUIRE device client cert). The broker only splices
//      ciphertext — TLS never terminates off-node.
//
// Revocation: an optional isRevokedSerial hook rejects revoked device certs
// right after the handshake (identity.mjs owns the CRL).

import net from "node:net";
import tls from "node:tls";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Duplex } from "node:stream";

const SIGNATURE_CONTEXT = "relay-tunnel-auth-v1";

const FRAME_SYN = 1;
const FRAME_DATA = 2;
const FRAME_FIN = 3;
const FRAME_RST = 4;
const FRAME_PING = 5;
const FRAME_PONG = 6;

const HEADER_BYTES = 9;
const WRITE_CHUNK_BYTES = 32 * 1024;
const MAX_FRAME_PAYLOAD = 1 << 20;
const MAX_AUTH_MSG_BYTES = 4 << 10;

// --------------------------------------------------------------------------
// Frame codec
// --------------------------------------------------------------------------

function encodeFrame(type, streamId, payload = Buffer.alloc(0)) {
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt8(type, 0);
  header.writeUInt32BE(streamId >>> 0, 1);
  header.writeUInt32BE(payload.length, 5);
  return payload.length ? Buffer.concat([header, payload]) : header;
}

// Incremental frame parser. Call push(buffer); complete frames invoke
// onFrame({type, streamId, payload}); protocol violations invoke onError.
function createFrameParser(onFrame, onError) {
  let buffered = Buffer.alloc(0);
  return {
    push(chunk) {
      buffered = buffered.length ? Buffer.concat([buffered, chunk]) : Buffer.from(chunk);
      for (;;) {
        if (buffered.length < HEADER_BYTES) return;
        const type = buffered.readUInt8(0);
        const streamId = buffered.readUInt32BE(1);
        const length = buffered.readUInt32BE(5);
        if (length > MAX_FRAME_PAYLOAD) {
          onError(new Error(`mux: oversized frame (${length} bytes)`));
          return;
        }
        if (buffered.length < HEADER_BYTES + length) return;
        const payload = buffered.subarray(HEADER_BYTES, HEADER_BYTES + length);
        buffered = buffered.subarray(HEADER_BYTES + length);
        onFrame({ type, streamId, payload: Buffer.from(payload) });
      }
    },
  };
}

// --------------------------------------------------------------------------
// Registration handshake
// --------------------------------------------------------------------------

function signedPayload(nodeId, challenge) {
  return Buffer.concat([
    Buffer.from(SIGNATURE_CONTEXT, "utf8"),
    Buffer.from([0]),
    Buffer.from(nodeId, "utf8"),
    Buffer.from([0]),
    challenge,
  ]);
}

function signChallenge(nodeId, challengeBase64, identityKeyPem) {
  const challenge = Buffer.from(challengeBase64, "base64");
  const key = crypto.createPrivateKey(identityKeyPem);
  // Ed25519: algorithm is implied by the key; pass null.
  return crypto.sign(null, signedPayload(nodeId, challenge), key).toString("base64");
}

function writeLengthPrefixed(socket, value) {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  const frame = Buffer.alloc(4 + body.length);
  frame.writeUInt32BE(body.length, 0);
  body.copy(frame, 4);
  socket.write(frame);
}

// Reads exactly one length-prefixed JSON message from pre-buffered data.
// Returns {message, rest} or null when incomplete.
function takeLengthPrefixed(buffered) {
  if (buffered.length < 4) return null;
  const length = buffered.readUInt32BE(0);
  if (length > MAX_AUTH_MSG_BYTES) throw new Error("tunnel auth message too large");
  if (buffered.length < 4 + length) return null;
  const message = JSON.parse(buffered.subarray(4, 4 + length).toString("utf8"));
  return { message, rest: buffered.subarray(4 + length) };
}

// --------------------------------------------------------------------------
// Mux stream as a net.Conn-ish Duplex
// --------------------------------------------------------------------------

class MuxStream extends Duplex {
  constructor(session, id) {
    super({ allowHalfOpen: true });
    this.session = session;
    this.id = id;
    this.finSent = false;
    this.rstSent = false;
    this.peerFin = false;
  }

  _read() {}

  _write(chunk, _encoding, callback) {
    for (let offset = 0; offset < chunk.length; offset += WRITE_CHUNK_BYTES) {
      this.session.sendFrame(FRAME_DATA, this.id, chunk.subarray(offset, offset + WRITE_CHUNK_BYTES));
    }
    callback();
  }

  _final(callback) {
    if (!this.finSent && !this.rstSent) {
      this.finSent = true;
      this.session.sendFrame(FRAME_FIN, this.id);
    }
    callback();
  }

  _destroy(error, callback) {
    if (error && !this.rstSent && !this.session.closed) {
      this.rstSent = true;
      this.session.sendFrame(FRAME_RST, this.id);
    }
    this.session.streams.delete(this.id);
    callback(error);
  }

  handlePeerData(payload) {
    this.push(payload);
  }

  handlePeerFin() {
    this.peerFin = true;
    this.push(null);
  }

  handlePeerRst() {
    this.session.streams.delete(this.id);
    this.destroy();
  }
}

// --------------------------------------------------------------------------
// Forwarded-subject synthesis (the tunneled equivalent of the gateway)
// --------------------------------------------------------------------------
//
// In direct mode the TLS-terminating gateway (nginx/Caddy) verifies the
// device client cert and forwards two headers that server.authorize() trusts:
//
//   X-SSL-Client-Verify: SUCCESS
//   X-SSL-Client-S-DN:   <subject DN, RFC 2253>
//
// In tunneled mode TLS terminates HERE, so there is no gateway and the
// request arrives straight from the device — which means the device could
// simply send those headers itself and impersonate another enrolled device.
// Every tunneled request therefore goes through
// `applyTunnelClientCertHeaders`, which (1) deletes EVERY inbound
// x-ssl-client-* header before anything can read it and (2) re-adds the pair
// derived from the TLS peer certificate. No peer certificate => no headers
// => authorize() fails closed.

const CLIENT_CERT_HEADER = /^x-ssl-client-/i;

// nginx's $ssl_client_s_dn is RFC 2253: RDNs most-specific-first, joined with
// "," and no spaces. Node's X509Certificate.subject is the same escaping in
// DER order, one RDN per line — so the DN is the reversed line list.
function subjectDnFromCertificate(peerCertificate) {
  const raw = peerCertificate && typeof peerCertificate === "object" ? peerCertificate.raw : null;
  if (!raw || !raw.length) return null;
  let parsed;
  try {
    parsed = new crypto.X509Certificate(raw);
  } catch {
    return null;
  }
  const subject = typeof parsed.subject === "string" ? parsed.subject : "";
  const rdns = subject
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .reverse();
  return rdns.length ? rdns.join(",") : null;
}

// Deletes forged x-ssl-client-* headers, then injects the cert-derived pair.
// Returns the injected subject DN, or null when the request is
// unauthenticated (in which case both headers stay absent and authorize()
// rejects with 401 under CODEX_REQUIRE_MTLS).
function applyTunnelClientCertHeaders(req) {
  for (const name of Object.keys(req.headers || {})) {
    if (CLIENT_CERT_HEADER.test(name)) delete req.headers[name];
  }
  if (Array.isArray(req.rawHeaders)) {
    const kept = [];
    for (let index = 0; index + 1 < req.rawHeaders.length; index += 2) {
      if (CLIENT_CERT_HEADER.test(req.rawHeaders[index])) continue;
      kept.push(req.rawHeaders[index], req.rawHeaders[index + 1]);
    }
    req.rawHeaders.splice(0, req.rawHeaders.length, ...kept);
  }

  const socket = req.socket;
  if (!socket || typeof socket.getPeerCertificate !== "function") return null;
  // `authorized` is false when the handshake did not verify the chain; the
  // tls.Server below rejects those outright, this is belt-and-braces.
  if (socket.authorized !== true) return null;
  const subject = subjectDnFromCertificate(socket.getPeerCertificate());
  if (!subject) return null;

  req.headers["x-ssl-client-verify"] = "SUCCESS";
  req.headers["x-ssl-client-s-dn"] = subject;
  return subject;
}

// Wraps a request handler so it can only ever see cert-derived subjects.
function wrapTunneledHandler(handler) {
  return function tunneledRequestHandler(req, res) {
    applyTunnelClientCertHeaders(req);
    return handler(req, res);
  };
}

// --------------------------------------------------------------------------
// Tunnel client
// --------------------------------------------------------------------------

// Dials the broker, authenticates with the node identity key, then serves
// `handler` (an http request handler) over per-stream TLS with required
// device client certs. Returns a handle with close().
//
// The handler is ALWAYS wrapped by wrapTunneledHandler — callers cannot opt
// out, so passing server.routeRequest straight in is safe.
function startTunnelClient({
  brokerHost,
  brokerPort,
  nodeId,
  identityKeyPem,
  tlsCertPem,
  tlsKeyPem,
  deviceCaPem,
  handler,
  isRevokedSerial = null,
  heartbeatMs = 15000,
  onError = () => {},
}) {
  const httpServer = http.createServer(wrapTunneledHandler(handler));
  // A non-listening tls.Server gives the full server-side handshake
  // semantics (requestCert + rejectUnauthorized enforcement, proper fatal
  // alerts, `authorized` bookkeeping) that a hand-rolled TLSSocket lacks.
  // Mux streams are fed to it as raw "connections".
  // A device-token node does not demand a certificate at the handshake.
  //
  // Requiring one makes the machine unreachable from iOS, which will not send
  // a client certificate on a connection whose server certificate it did not
  // itself anchor — it declines silently, so the handshake fails with nothing
  // for either side to report. Authentication moves up a layer: authorize()
  // in server.mjs requires a bearer token on every request and rejects with
  // 401 until pairing has written one, so the machine is never open. Nodes
  // without a token file keep certificate authentication exactly as before.
  const usesDeviceToken = Boolean(process.env.RELAYD_DEVICE_TOKEN_HASH_FILE);
  const tlsServer = new tls.Server({
    cert: tlsCertPem,
    key: tlsKeyPem,
    ca: deviceCaPem,
    requestCert: !usesDeviceToken,
    rejectUnauthorized: !usesDeviceToken,
  });
  tlsServer.on("secureConnection", (secureSocket) => {
    if (typeof isRevokedSerial === "function") {
      const peer = secureSocket.getPeerCertificate();
      const serial = (peer?.serialNumber || "").toUpperCase();
      if (serial && isRevokedSerial(serial)) {
        // Revoked device certs die right after the handshake (CRL owned by
        // identity.mjs).
        secureSocket.destroy();
        return;
      }
    }
    httpServer.emit("connection", secureSocket);
  });
  tlsServer.on("tlsClientError", (error, socket) => {
    // Record why, then destroy. Discarding this error left every failed mTLS
    // handshake indistinguishable from every other: a client that sent no
    // certificate, one whose certificate did not chain to this node's CA, and
    // one that hung up mid-handshake all looked identical from here, and
    // nothing on the client says which either — iOS reports the same opaque
    // -1200/-1206 for all of them. Node names them apart
    // (ERR_SSL_PEER_DID_NOT_RETURN_A_CERTIFICATE vs
    // ERR_SSL_TLSV1_ALERT_UNKNOWN_CA and friends), so this is the only place
    // the distinction exists.
    //
    // Written to a file as well as stderr because a sandbox's stdout is
    // captured only while it boots; by the time a phone connects, nothing is
    // listening. Bounded to the last few entries so it cannot grow without
    // limit, and it carries no key material — an error code and, when the
    // peer sent one, the certificate's subject and issuer.
    try {
      const peer = typeof socket?.getPeerCertificate === "function"
        ? socket.getPeerCertificate()
        : null;
      const entry = JSON.stringify({
        at: new Date().toISOString(),
        code: error?.code || error?.name || "unknown",
        message: String(error?.message || "").slice(0, 200),
        peerSubject: peer?.subject?.CN ?? null,
        peerIssuer: peer?.issuer?.CN ?? null,
      });
      console.error(`relayd: tls client error ${entry}`);
      const logPath = path.join(process.env.CODEX_DATA_DIR || "/var/lib/relayd", "tls-errors.log");
      let previous = "";
      try {
        previous = fs.readFileSync(logPath, "utf8");
      } catch {}
      const lines = `${previous}${entry}\n`.trim().split("\n").slice(-20);
      fs.writeFileSync(logPath, `${lines.join("\n")}\n`, { mode: 0o600 });
    } catch {
      // Diagnostics must never be able to take the listener down.
    }
    socket?.destroy();
  });

  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: brokerHost, port: brokerPort });
    socket.setNoDelay(true);

    const session = {
      socket,
      closed: false,
      streams: new Map(),
      heartbeatTimer: null,
      sendFrame(type, streamId, payload) {
        if (session.closed) return;
        try {
          socket.write(encodeFrame(type, streamId, payload));
        } catch (error) {
          close(error);
        }
      },
    };

    let registered = false;
    let authBuffer = Buffer.alloc(0);

    const parser = createFrameParser(
      (frame) => handleFrame(frame),
      (error) => close(error),
    );

    function close(error) {
      if (session.closed) return;
      session.closed = true;
      clearInterval(session.heartbeatTimer);
      for (const stream of session.streams.values()) {
        stream.destroy();
      }
      session.streams.clear();
      socket.destroy();
      if (error) onError(error);
      if (!registered) reject(error || new Error("tunnel closed before registration"));
    }

    function handleFrame({ type, streamId, payload }) {
      if (type === FRAME_PING) {
        session.sendFrame(FRAME_PONG, 0);
        return;
      }
      if (type === FRAME_PONG) return;
      if (type === FRAME_SYN) {
        const stream = new MuxStream(session, streamId);
        session.streams.set(streamId, stream);
        serveTlsOnStream(stream);
        return;
      }
      const stream = session.streams.get(streamId);
      if (!stream) return;
      if (type === FRAME_DATA) stream.handlePeerData(payload);
      else if (type === FRAME_FIN) stream.handlePeerFin();
      else if (type === FRAME_RST) stream.handlePeerRst();
    }

    function serveTlsOnStream(stream) {
      // TLS terminates on the node with a node-CA server cert; device client
      // certs are REQUIRED and verified against the device CA. This is the
      // only data-path auth — no tokens anywhere.
      tlsServer.emit("connection", stream);
    }

    socket.on("data", (chunk) => {
      if (registered) {
        parser.push(chunk);
        return;
      }
      authBuffer = authBuffer.length ? Buffer.concat([authBuffer, chunk]) : Buffer.from(chunk);
      try {
        const taken = takeLengthPrefixed(authBuffer);
        if (!taken) return;
        authBuffer = Buffer.from(taken.rest);
        const message = taken.message;
        if (message.challenge) {
          writeLengthPrefixed(socket, {
            v: 1,
            node_id: nodeId,
            sig: signChallenge(nodeId, message.challenge, identityKeyPem),
          });
          return;
        }
        if (message.ok === true) {
          registered = true;
          // Anything already buffered past the result belongs to the mux.
          if (authBuffer.length) parser.push(authBuffer);
          authBuffer = Buffer.alloc(0);
          session.heartbeatTimer = setInterval(() => session.sendFrame(FRAME_PING, 0), heartbeatMs);
          session.heartbeatTimer.unref();
          resolve({
            close: () => close(null),
            get streamCount() {
              return session.streams.size;
            },
          });
          return;
        }
        close(new Error(`tunnel registration rejected: ${message.error || "unknown error"}`));
      } catch (error) {
        close(error);
      }
    });

    socket.on("error", (error) => close(error));
    socket.on("close", () => close(new Error("tunnel connection closed")));
  });
}

// --------------------------------------------------------------------------
// Supervisor: reconnect with exponential backoff + jitter
// --------------------------------------------------------------------------

// attempt 1 => [base/2, base], attempt 2 => [base, 2*base], … capped at
// maxMs. Decorrelating the delay keeps a fleet of nodes from stampeding a
// broker that just came back.
function computeBackoffDelay(attempt, { baseMs = 1000, maxMs = 30000, random = Math.random } = {}) {
  const exponential = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  const half = exponential / 2;
  return Math.max(1, Math.round(half + random() * half));
}

// Keeps exactly one registered tunnel session alive: dials, reports state
// transitions through onState, and reconnects with backoff until stop().
// Returns synchronously — a broker that is down at boot must not stop the
// daemon from starting.
//
// States: "connecting" -> "registered" | "reconnecting" -> … -> "stopped".
function startTunnelService({
  backoffBaseMs = 1000,
  backoffMaxMs = 30000,
  random = Math.random,
  onState = () => {},
  connect = startTunnelClient,
  ...clientOptions
} = {}) {
  let stopped = false;
  let client = null;
  let timer = null;
  let attempt = 0;
  let state = "connecting";
  // Identifies the in-flight dial so a failure reported twice (onError plus a
  // rejected promise) only schedules one reconnect, and so a late callback
  // from a superseded session is ignored.
  let token = null;

  function transition(next, detail = {}) {
    state = next;
    try {
      onState(next, detail);
    } catch {
      // Logging must never take the tunnel down.
    }
  }

  function scheduleReconnect(error) {
    if (stopped) return;
    attempt += 1;
    const delayMs = computeBackoffDelay(attempt, { baseMs: backoffBaseMs, maxMs: backoffMaxMs, random });
    transition("reconnecting", { attempt, delayMs, error: error?.message || null });
    // Deliberately NOT unref'd: while the tunnel is the node's only listener,
    // a pending reconnect is the one thing keeping the daemon alive. stop()
    // clears it, which is how the process is allowed to exit.
    timer = setTimeout(() => {
      timer = null;
      dial();
    }, delayMs);
  }

  function dial() {
    if (stopped) return;
    const dialToken = {};
    token = dialToken;
    transition("connecting", { attempt: attempt + 1 });

    Promise.resolve()
      .then(() =>
        connect({
          ...clientOptions,
          onError: (error) => {
            if (stopped || token !== dialToken) return;
            token = null;
            client = null;
            scheduleReconnect(error);
          },
        }),
      )
      .then((handle) => {
        if (stopped || token !== dialToken) {
          // Stopped, or the session already failed and a reconnect is queued.
          handle?.close?.();
          return;
        }
        client = handle;
        attempt = 0;
        transition("registered", {});
      })
      .catch((error) => {
        if (stopped || token !== dialToken) return;
        token = null;
        scheduleReconnect(error);
      });
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    token = null;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (client) {
      client.close();
      client = null;
    }
    transition("stopped", {});
  }

  dial();

  return {
    stop,
    get state() {
      return state;
    },
    get attempt() {
      return attempt;
    },
    get connected() {
      return Boolean(client);
    },
  };
}

export {
  SIGNATURE_CONTEXT,
  FRAME_SYN,
  FRAME_DATA,
  FRAME_FIN,
  FRAME_RST,
  FRAME_PING,
  FRAME_PONG,
  WRITE_CHUNK_BYTES,
  MAX_FRAME_PAYLOAD,
  encodeFrame,
  createFrameParser,
  signedPayload,
  signChallenge,
  MuxStream,
  CLIENT_CERT_HEADER,
  subjectDnFromCertificate,
  applyTunnelClientCertHeaders,
  wrapTunneledHandler,
  computeBackoffDelay,
  startTunnelClient,
  startTunnelService,
};
