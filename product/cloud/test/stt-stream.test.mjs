// The live dictation proxy: ws://…/v1/stt/stream.
//
// Sarvam is never reached. Every test stands a fake provider in-process and
// points SARVAM_STT_WS_URL at it, so the handshake query, the subscription-key
// header and the audio frames asserted here are the exact bytes a real Sarvam
// session would receive — the contract is verified, not mocked away.

import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { WebSocketServer, WebSocket } from "ws";

import { loadConfig } from "../src/config.js";
import { createSttStream } from "../src/stt-stream.js";

const SECRET = "test-stt-shared-secret-0123456789";
const SARVAM_KEY = "test-sarvam-subscription-key";
const PCM = Buffer.from("0123456789abcdef", "utf8"); // stands in for 16 kHz PCM

// ── fake Sarvam ───────────────────────────────────────────────────────────
async function startFakeSarvam() {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(wss, "listening");
  const sessions = [];
  wss.on("connection", (socket, req) => {
    const session = { socket, url: req.url, headers: req.headers, frames: [], closed: false };
    socket.on("message", (raw) => session.frames.push(JSON.parse(raw.toString("utf8"))));
    socket.on("close", () => {
      session.closed = true;
    });
    sessions.push(session);
  });
  return {
    url: `ws://127.0.0.1:${wss.address().port}/speech-to-text/ws`,
    sessions,
    transcribe: (session, transcript) =>
      session.socket.send(JSON.stringify({ type: "data", data: { transcript } })),
    close: () =>
      new Promise((resolve) => {
        for (const session of sessions) session.socket.terminate();
        wss.close(resolve);
      }),
  };
}

// ── proxy under test ──────────────────────────────────────────────────────
async function startProxy(env = {}) {
  const sarvam = await startFakeSarvam();
  const config = loadConfig({
    RELAY_STT_SHARED_SECRET: SECRET,
    SARVAM_API_KEY: SARVAM_KEY,
    SARVAM_STT_WS_URL: sarvam.url,
    ...env,
  });
  const server = createServer((req, res) => {
    res.writeHead(404);
    res.end();
  });
  const logs = [];
  const stt = createSttStream({ server, config, log: (msg) => logs.push(msg) });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `ws://127.0.0.1:${server.address().port}`;
  return {
    sarvam,
    stt,
    config,
    logs,
    origin,
    url: `${origin}/v1/stt/stream`,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
      await sarvam.close();
    },
  };
}

// Messages and the close are RECORDED rather than awaited as events: the proxy
// sends the settling frame and the close back to back, so a listener attached
// after the first one has already missed the second.
async function openClient(url, headers = { "x-relay-stt-key": SECRET }) {
  const socket = new WebSocket(url, { headers });
  const messages = [];
  const closes = [];
  socket.on("message", (raw) => messages.push(JSON.parse(raw.toString("utf8"))));
  socket.on("close", (code, reason) => closes.push({ code, reason: reason.toString("utf8") }));
  await once(socket, "open");
  return { socket, messages, closes };
}

// Resolves with the HTTP status of a refused upgrade. `unexpected-response`
// fires only for a non-101 answer, which is exactly the rejection path: a
// handshake that succeeded would resolve nothing and fail the assertion.
function upgradeStatus(url, options = {}) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, options);
    socket.on("unexpected-response", (_req, res) => {
      res.resume();
      resolve(res.statusCode);
    });
    socket.on("open", () => {
      socket.terminate();
      reject(new Error("upgrade was accepted"));
    });
    socket.on("error", reject);
  });
}

async function waitFor(label, predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const audioFrame = (pcm) => ({
  audio: { data: pcm.toString("base64"), sample_rate: "16000", encoding: "audio/wav" },
});

// ── auth ──────────────────────────────────────────────────────────────────

test("no shared secret is 401 and opens nothing upstream", async () => {
  const t = await startProxy();
  try {
    assert.equal(await upgradeStatus(t.url, {}), 401);
    assert.equal(t.sarvam.sessions.length, 0, "an unauthenticated caller must never reach the provider");
    assert.equal(t.stt.sessions.size, 0);
  } finally {
    await t.close();
  }
});

test("a wrong shared secret is 401, header or query", async () => {
  const t = await startProxy();
  try {
    assert.equal(await upgradeStatus(t.url, { headers: { "x-relay-stt-key": "nope" } }), 401);
    assert.equal(await upgradeStatus(`${t.url}?key=nope`), 401);
    // A prefix of the real secret is the case a naive length-then-compare gets
    // wrong; timingSafeEqual needs the length guard in front of it.
    assert.equal(await upgradeStatus(`${t.url}?key=${SECRET.slice(0, 8)}`), 401);
    assert.equal(t.sarvam.sessions.length, 0);
  } finally {
    await t.close();
  }
});

test("RELAY_STT_SHARED_SECRET unset disables the endpoint entirely", async () => {
  const t = await startProxy({ RELAY_STT_SHARED_SECRET: "" });
  try {
    assert.equal(await upgradeStatus(t.url, { headers: { "x-relay-stt-key": "" } }), 401);
    assert.equal(await upgradeStatus(t.url, { headers: { "x-relay-stt-key": SECRET } }), 401);
  } finally {
    await t.close();
  }
});

test("the ?key= query fallback is accepted", async () => {
  const t = await startProxy();
  try {
    const { socket } = await openClient(`${t.url}?key=${SECRET}`, {});
    await waitFor("upstream connection", () => t.sarvam.sessions.length === 1);
    socket.close();
  } finally {
    await t.close();
  }
});

test("SARVAM_API_KEY unset is 503, and only after the caller authenticates", async () => {
  const t = await startProxy({ SARVAM_API_KEY: "" });
  try {
    assert.equal(await upgradeStatus(t.url, { headers: { "x-relay-stt-key": SECRET } }), 503);
    // Configuration state is not something an unauthenticated caller gets to
    // probe: without the secret the answer is 401 whatever the provider config.
    assert.equal(await upgradeStatus(t.url, {}), 401);
    assert.equal(t.stt.sessions.size, 0);
  } finally {
    await t.close();
  }
});

test("an upgrade to any other path is refused rather than left hanging", async () => {
  const t = await startProxy();
  try {
    assert.equal(await upgradeStatus(`${t.origin}/v1/handoffs`, { headers: { "x-relay-stt-key": SECRET } }), 404);
  } finally {
    await t.close();
  }
});

// ── the proxied session ───────────────────────────────────────────────────

test("audio reaches Sarvam in its exact frame shape and partials stream back", async () => {
  const t = await startProxy();
  try {
    const { socket, messages } = await openClient(t.url);
    const [upstream] = await waitFor("upstream connection", () =>
      t.sarvam.sessions.length === 1 ? t.sarvam.sessions : null,
    );

    assert.equal(upstream.url, "/speech-to-text/ws?model=saarika:v2.5&language-code=unknown");
    assert.equal(upstream.headers["api-subscription-key"], SARVAM_KEY);

    socket.send(JSON.stringify(audioFrame(PCM)));
    await waitFor("audio frame", () => upstream.frames.length === 1);
    assert.deepEqual(upstream.frames[0], {
      audio: { data: PCM.toString("base64"), sample_rate: "16000", encoding: "audio/wav" },
    });

    t.sarvam.transcribe(upstream, "hello");
    await waitFor("first partial", () => messages.length === 1);
    assert.deepEqual(messages[0], { type: "partial", text: "hello" });

    t.sarvam.transcribe(upstream, "world");
    await waitFor("second partial", () => messages.length === 2);
    assert.deepEqual(messages[1], { type: "partial", text: "hello world" });

    socket.close();
  } finally {
    await t.close();
  }
});

test("audio sent before the provider handshake completes is not dropped", async () => {
  const t = await startProxy();
  try {
    // The phone starts talking the instant the button goes down — the first
    // chunks are always in flight while the upstream handshake is still open.
    const { socket } = await openClient(t.url);
    socket.send(JSON.stringify(audioFrame(PCM)));
    socket.send(JSON.stringify(audioFrame(PCM)));

    const [upstream] = await waitFor("upstream connection", () =>
      t.sarvam.sessions.length === 1 ? t.sarvam.sessions : null,
    );
    await waitFor("queued audio", () => upstream.frames.length === 2);
    socket.close();
  } finally {
    await t.close();
  }
});

test("flush is forwarded verbatim and settles the whole utterance", async () => {
  const t = await startProxy();
  try {
    const { socket, messages } = await openClient(t.url);
    const [upstream] = await waitFor("upstream connection", () =>
      t.sarvam.sessions.length === 1 ? t.sarvam.sessions : null,
    );

    t.sarvam.transcribe(upstream, "मुझे लगता है");
    await waitFor("partial", () => messages.length === 1);

    socket.send(JSON.stringify({ type: "flush" }));
    await waitFor("flush upstream", () => upstream.frames.length === 1);
    assert.deepEqual(upstream.frames[0], { type: "flush" });

    t.sarvam.transcribe(upstream, "this works");
    const settled = await waitFor("final", () => messages.find((m) => m.type === "final"));
    assert.deepEqual(settled, { type: "final", text: "मुझे लगता है this works" });

    socket.close();
  } finally {
    await t.close();
  }
});

test("a flush the provider never answers still settles when it hangs up", async () => {
  const t = await startProxy();
  try {
    const { socket, messages, closes } = await openClient(t.url);
    const [upstream] = await waitFor("upstream connection", () =>
      t.sarvam.sessions.length === 1 ? t.sarvam.sessions : null,
    );
    t.sarvam.transcribe(upstream, "half a sentence");
    await waitFor("partial", () => messages.length === 1);

    socket.send(JSON.stringify({ type: "flush" }));
    await waitFor("flush upstream", () => upstream.frames.length === 1);
    upstream.socket.close();

    const settled = await waitFor("final", () => messages.find((m) => m.type === "final"));
    assert.deepEqual(settled, { type: "final", text: "half a sentence" });
    await waitFor("client close", () => closes.length === 1);
    assert.equal(socket.readyState, WebSocket.CLOSED);
  } finally {
    await t.close();
  }
});

// ── no leaked sockets ─────────────────────────────────────────────────────

test("closing the client closes the upstream socket", async () => {
  const t = await startProxy();
  try {
    const { socket } = await openClient(t.url);
    const [upstream] = await waitFor("upstream connection", () =>
      t.sarvam.sessions.length === 1 ? t.sarvam.sessions : null,
    );
    assert.equal(t.stt.sessions.size, 1);

    socket.close();
    await waitFor("upstream close", () => upstream.closed);
    await waitFor("session release", () => t.stt.sessions.size === 0);
  } finally {
    await t.close();
  }
});

test("an upstream that hangs up ends the client session", async () => {
  const t = await startProxy();
  try {
    const { closes } = await openClient(t.url);
    const [upstream] = await waitFor("upstream connection", () =>
      t.sarvam.sessions.length === 1 ? t.sarvam.sessions : null,
    );

    upstream.socket.close();
    await waitFor("client close", () => closes.length === 1);
    await waitFor("session release", () => t.stt.sessions.size === 0);
  } finally {
    await t.close();
  }
});

test("a provider that cannot be reached is reported as an error, not a silence", async () => {
  // Port 1 is never listening, which is the shape of every upstream failure
  // the phone actually meets: a provider outage, a DNS failure, a rejected key.
  const t = await startProxy({ SARVAM_STT_WS_URL: "ws://127.0.0.1:1" });
  try {
    const { messages, closes } = await openClient(t.url);

    const failure = await waitFor("error frame", () => messages.find((m) => m.type === "error"));
    assert.deepEqual(failure, { type: "error", message: "upstream_failed" });
    const closed = await waitFor("client close", () => closes[0]);
    assert.equal(closed.code, 1011);
    assert.equal(t.stt.sessions.size, 0);

    // Operators need to know the provider is down; nobody needs the
    // subscription key, and it travels in the URL's headers.
    assert.equal(t.logs.length, 1);
    assert.match(t.logs[0], /^stt upstream failed: /);
    assert.doesNotMatch(t.logs[0], new RegExp(SARVAM_KEY));
  } finally {
    await t.close();
  }
});

// ── limits ────────────────────────────────────────────────────────────────

test("exceeding the audio byte cap closes both sockets", async () => {
  const t = await startProxy({ STT_MAX_AUDIO_BYTES: "64" });
  try {
    const { socket, messages, closes } = await openClient(t.url);
    const [upstream] = await waitFor("upstream connection", () =>
      t.sarvam.sessions.length === 1 ? t.sarvam.sessions : null,
    );

    socket.send(JSON.stringify(audioFrame(Buffer.alloc(48))));
    socket.send(JSON.stringify(audioFrame(Buffer.alloc(48))));

    const closed = await waitFor("client close", () => closes[0]);
    assert.equal(closed.code, 1009);
    assert.equal(closed.reason, "audio_byte_limit");
    assert.deepEqual(messages.at(-1), { type: "error", message: "audio_byte_limit" });
    await waitFor("upstream close", () => upstream.closed);
    assert.equal(t.stt.sessions.size, 0);
  } finally {
    await t.close();
  }
});

test("exceeding the session duration closes both sockets", async () => {
  const t = await startProxy({ STT_MAX_SESSION_SEC: "1" });
  try {
    const { messages, closes } = await openClient(t.url);
    const [upstream] = await waitFor("upstream connection", () =>
      t.sarvam.sessions.length === 1 ? t.sarvam.sessions : null,
    );

    const closed = await waitFor("client close", () => closes[0], 3000);
    assert.equal(closed.code, 1008);
    assert.equal(closed.reason, "session_time_limit");
    assert.deepEqual(messages.at(-1), { type: "error", message: "session_time_limit" });
    await waitFor("upstream close", () => upstream.closed);
    assert.equal(t.stt.sessions.size, 0);
  } finally {
    await t.close();
  }
});
