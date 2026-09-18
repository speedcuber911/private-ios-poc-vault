// Live dictation proxy: the WebSocket at /v1/stt/stream.
//
// The phone holds the mic button, streams microphone audio here, and sees the
// transcript fill while the user is still speaking. Sarvam does the
// transcribing; SARVAM_API_KEY never leaves this process. That is the whole
// reason this endpoint exists instead of the app talking to Sarvam directly —
// a key shipped inside an app binary is a key that has been published.
//
// The gate is RELAY_STT_SHARED_SECRET, which is NOT an account session: it
// authorizes dictation and nothing else, carries no identity, and is never
// accepted as authentication anywhere else in this server.
//
// ── WIRE FORMAT (iOS → cloud) ─────────────────────────────────────────────
//   GET /v1/stt/stream            (WebSocket upgrade)
//   x-relay-stt-key: <shared secret>          — or ?key=<shared secret>
//
//   Audio, one text frame per chunk (~100 ms on the device):
//     {"audio":{"data":"<base64 of raw 16 kHz mono LE int16 PCM>",
//               "sample_rate":"16000","encoding":"audio/wav"}}
//   Finalize the utterance:
//     {"type":"flush"}
//
// ── WIRE FORMAT (cloud → iOS) ─────────────────────────────────────────────
//   {"type":"partial","text":"<everything transcribed so far>"}
//   {"type":"final","text":"<the settled utterance>"}     after a flush
//   {"type":"error","message":"<code>"}                   followed by a close
//
// The phone never sees a provider frame. This server builds every upstream
// frame itself from bytes it decoded, so a client bug cannot produce something
// Sarvam rejects, and a change in the provider's format is a deploy here
// rather than an App Store release.
//
// ── UPSTREAM CONTRACT (cloud → Sarvam), verified against a working client ──
//   wss://api.sarvam.ai/speech-to-text/ws?model=<model>&language-code=<code>
//   api-subscription-key: <SARVAM_API_KEY>        (on the handshake)
//   audio  → {"audio":{"data":"<base64 PCM>","sample_rate":"16000",
//                      "encoding":"audio/wav"}}
//   flush  → {"type":"flush"}
//   result ← {"type":"data","data":{"transcript":"..."}}, one frame per
//            settled segment; the utterance is those segments in arrival
//            order, never a growing whole.

import { timingSafeEqual } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";

const STREAM_PATH = "/v1/stt/stream";

// Properties of what the app's audio converter produces, not operator
// preferences, so they are fixed here rather than in config. "audio/wav" is
// the provider's label for raw PCM — it is not a mistake and there is no
// RIFF header on the wire.
const SAMPLE_RATE = "16000";
const ENCODING = "audio/wav";

const FLUSH_FRAME = JSON.stringify({ type: "flush" });

// Close codes the phone may see. Both limits are policy, so 1008 covers the
// clock and 1009 ("message too big", the nearest standard code for "you sent
// more than we will carry") covers the byte cap.
const CLOSE_TIME_LIMIT = 1008;
const CLOSE_BYTE_LIMIT = 1009;
const CLOSE_UPSTREAM_FAILED = 1011;

export function createSttStream({ server, config, log = (msg) => console.warn(msg) }) {
  const settings = config.stt;
  const wss = new WebSocketServer({ noServer: true });
  // The live client sockets, so a leak is observable rather than inferred.
  // Exposed in the same spirit as server.js's handoffWaiters — not an API.
  const sessions = new Set();

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, "http://localhost");
    // Node destroys an unhandled upgrade only while NO 'upgrade' listener is
    // attached. From the moment this module attaches one, every upgrade that
    // reaches this server — including one for a path this module does not own
    // — is ours to answer and destroy, or the socket is leaked.
    if (url.pathname !== STREAM_PATH) return rejectUpgrade(socket, 404, "Not Found");
    // Authenticate before answering anything about configuration: an
    // unauthenticated caller learns only that it is unauthenticated, never
    // whether this deployment has a provider key.
    if (!secretMatches(req, url, settings.sharedSecret)) {
      return rejectUpgrade(socket, 401, "Unauthorized");
    }
    if (!settings.sarvamApiKey) return rejectUpgrade(socket, 503, "Service Unavailable");
    wss.handleUpgrade(req, socket, head, openSession);
  });

  function openSession(client) {
    const segments = [];
    // Audio the phone sent while the provider handshake was still in flight.
    // Bounded by the byte cap below, so this can never hold more than one
    // session's worth of audio.
    const queued = [];
    let audioBytes = 0;
    let flushPending = false;
    let finished = false;

    const upstream = new WebSocket(upstreamUrl(settings), {
      headers: { "api-subscription-key": settings.sarvamApiKey },
    });

    sessions.add(client);

    const deadline = setTimeout(
      () => fail(CLOSE_TIME_LIMIT, "session_time_limit"),
      settings.maxSessionSec * 1000,
    );
    deadline.unref?.();

    // The one way out. Every path — client close, upstream close, either
    // error, either limit — lands here, which is what makes "no upstream
    // socket outlives the phone that opened it" a property of this module
    // rather than a hope about event ordering.
    function finish(code = 1000, reason = "") {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      sessions.delete(client);
      // terminate(), not close(): a provider that never answers the closing
      // handshake would otherwise hold the socket — and the metered session
      // behind it — open for as long as it liked.
      if (upstream.readyState !== WebSocket.CLOSED) upstream.terminate();
      if (client.readyState === WebSocket.OPEN) client.close(code, reason);
      else client.terminate();
    }

    function send(payload) {
      if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(payload));
    }

    // The close reason alone is not enough: a WebSocket client sees close
    // codes late and inconsistently, so the phone is told in a frame it
    // already knows how to render, then closed.
    function fail(code, message) {
      send({ type: "error", message });
      finish(code, message);
    }

    function sendUpstream(frame) {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(frame);
      else if (upstream.readyState === WebSocket.CONNECTING) queued.push(frame);
    }

    client.on("message", (raw, isBinary) => {
      if (finished || isBinary) return;
      const frame = parseJson(raw);
      if (!frame) return;

      if (frame.type === "flush") {
        flushPending = true;
        return sendUpstream(FLUSH_FRAME);
      }

      const encoded = frame.audio?.data;
      if (typeof encoded !== "string" || encoded.length === 0) return;
      const pcm = Buffer.from(encoded, "base64");
      if (pcm.length === 0) return;

      audioBytes += pcm.length;
      if (audioBytes > settings.maxAudioBytes) {
        return fail(CLOSE_BYTE_LIMIT, "audio_byte_limit");
      }

      // Re-encoded from the bytes we decoded, never forwarded as the client
      // spelled it: Node's base64 decoder is lenient (it accepts base64url and
      // skips junk), so re-encoding is the only way the provider is guaranteed
      // to receive exactly the bytes that were counted against the cap.
      sendUpstream(
        JSON.stringify({
          audio: { data: pcm.toString("base64"), sample_rate: SAMPLE_RATE, encoding: ENCODING },
        }),
      );
    });

    client.on("close", () => finish());
    client.on("error", () => finish());

    upstream.on("open", () => {
      for (const frame of queued) upstream.send(frame);
      queued.length = 0;
    });

    upstream.on("message", (raw) => {
      if (finished) return;
      const transcript = transcriptFrom(raw);
      if (transcript === null) return;
      segments.push(transcript);
      // A flush is the utterance boundary, so the first segment after it is
      // the tail: that frame settles the composer instead of growing it.
      if (flushPending) {
        flushPending = false;
        return send({ type: "final", text: utterance(segments) });
      }
      send({ type: "partial", text: utterance(segments) });
    });

    upstream.on("error", (err) => {
      if (finished) return;
      // Names the failure, never the URL or the headers — the subscription key
      // travels in those.
      log(`stt upstream failed: ${err?.message}`);
      fail(CLOSE_UPSTREAM_FAILED, "upstream_failed");
    });

    upstream.on("close", () => {
      if (finished) return;
      // A flush the provider never answered still has to settle: the phone is
      // waiting on `final`, and the words it already heard beat an empty
      // composer.
      if (flushPending) {
        flushPending = false;
        send({ type: "final", text: utterance(segments) });
      }
      finish(1000, "upstream_closed");
    });
  }

  return { sessions };
}

// ── helpers ───────────────────────────────────────────────────────────────

// The colon in "saarika:v2.5" is left unencoded, which is what the verified
// production client sends. Both values are operator configuration, never
// anything a caller supplies, so nothing user-controlled reaches this query.
// `vad_signals=true` is what makes this a streaming transcriber rather than a
// slow batch one: without it the provider answers only the flush, so the
// composer fills in one jump after the user stops talking.
//
// What it buys is segmentation on detected SILENCE, not a running word-by-word
// transcript: a live session gets a partial at each natural pause, and a single
// unbroken sentence still arrives whole at the flush. Worth knowing before
// chasing a "partials are broken" report — test audio without a real pause in
// it (`say` output, for one) produces no partials no matter what is set here,
// which cost an afternoon to work out.
//
// The codec and rate are declared on the connection as well as on every frame.
// The frames alone were not enough to earn interim results.
function upstreamUrl({ sarvamUrl, model, languageCode }) {
  return (
    `${sarvamUrl}?model=${model}&language-code=${languageCode}` +
    "&sample_rate=16000&input_audio_codec=pcm_s16le&vad_signals=true"
  );
}

// Same shape as server.js's bearerMatches, and for the same reason: an unset
// secret disables the endpoint rather than accepting the empty string, and the
// length guard is what keeps timingSafeEqual from throwing on a short offer.
//
// The header is how the app sends it; ?key= exists because a query string is
// the one thing every WebSocket client can set. It is the weaker channel — a
// query string reaches proxy access logs and the header does not — so prefer
// the header wherever the client can set one.
function secretMatches(req, url, expected) {
  if (!expected) return false;
  const header = req.headers["x-relay-stt-key"];
  const offered = (Array.isArray(header) ? header[0] : header) ?? url.searchParams.get("key");
  if (typeof offered !== "string" || offered.length === 0) return false;
  const got = Buffer.from(offered, "utf8");
  const want = Buffer.from(expected, "utf8");
  return got.length === want.length && timingSafeEqual(got, want);
}

function rejectUpgrade(socket, status, reason) {
  if (socket.writable) {
    socket.write(`HTTP/1.1 ${status} ${reason}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`);
  }
  socket.destroy();
}

function parseJson(raw) {
  try {
    const value = JSON.parse(raw.toString("utf8"));
    return value && typeof value === "object" ? value : null;
  } catch {
    // Dropped, not fatal: losing one 100 ms chunk is recoverable, and killing
    // the socket mid-sentence over a malformed frame is not.
    return null;
  }
}

// Sarvam also emits frames that are not transcripts; anything that is not a
// data frame carrying a string transcript is ignored.
function transcriptFrom(raw) {
  const frame = parseJson(raw);
  if (!frame || frame.type !== "data") return null;
  const transcript = frame.data?.transcript;
  return typeof transcript === "string" ? transcript : null;
}

// Segments arrive as settled phrases with no leading whitespace, so bare
// concatenation runs the last word of one into the first of the next — which
// in a mixed Hindi/English sentence is exactly where the boundary is. One
// space between segments is the only text this server adds; it never rewrites
// a segment's own words.
function utterance(segments) {
  return segments
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join(" ");
}
