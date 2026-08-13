// APNs client: HTTP/2 token-auth shape (provider JWT, ES256) behind an
// injectable transport so tests can assert exactly what would hit Apple.
//
// transport contract:
//   async ({ host, path, headers, body, signal }) => { status, headers, body }
//
// `signal` is an AbortSignal the client fires when its own deadline expires;
// a transport that ignores it still cannot hang the caller, because send()
// races the transport against that deadline itself.
//
// The `relay` payload block carries ids and event types only — never job
// titles, prompts, transcripts, or manifests. The banner (`aps.alert`) is the
// one part a user reads and the one part Apple can read as text; notify.js's
// bannerFor is the single place that decides what goes in it, and the comment
// there states exactly what that discloses.
//
// send() NEVER throws and never resolves "successfully" for a rejected push:
// it returns a classified {outcome, status, reason}. Callers fan out over many
// devices, and a fanout that treats "the promise resolved" as "Apple accepted
// it" is how a rotated-out signing key becomes invisible — every push 403s
// forever while the API reports success.

import { sign as cryptoSign, createPrivateKey, createHash } from "node:crypto";
import { b64urlJson } from "./jwt.js";

const PROVIDER_TOKEN_TTL_MS = 45 * 60 * 1000; // Apple allows 20–60 min

// One black-holed connection must not outlive one push. Applied by the client
// (so it holds for every transport) and again inside the http2 transport.
export const DEFAULT_APNS_TIMEOUT_MS = 10_000;

// apns-collapse-id is capped by Apple at 64 BYTES; anything longer is
// rejected with 400/BadCollapseId. Ids in this system are opaque and
// caller-chosen (UUID, ULID, nanoid…), so a collapse key built by
// concatenating them is a latent 400 that only shows up once ids get long —
// a UUID node id plus a UUID job id is already 73 bytes. Hash instead: the
// key is a fixed 32 ASCII bytes no matter what the inputs are.
export const APNS_COLLAPSE_ID_MAX_BYTES = 64;
const COLLAPSE_ID_CHARS = 32; // 32 base64url chars = 192 bits of the digest

// Collapse keys are per (node, job, push class). Push class MUST be part of
// the key: APNs evicts an undelivered notification when a later one arrives
// with the same collapse id, so sharing a key between a silent background
// sync and a user-actionable alert lets a low-priority push silently delete a
// "job needs your input" banner the user has not acted on yet.
//
// Parts are joined with "|", which the event-id grammar in notify.js excludes,
// and domain-separated so the digest is only ever a collapse key.
export function apnsCollapseId(...parts) {
  const input = ["relay-collapse-v1", ...parts.map((p) => String(p ?? ""))].join(
    "|",
  );
  return createHash("sha256")
    .update(input, "utf8")
    .digest("base64url")
    .slice(0, COLLAPSE_ID_CHARS);
}

// Classified send outcomes. Only DELIVERED means Apple accepted the push.
export const APNS_OUTCOME = {
  DELIVERED: "delivered", // 200
  UNREGISTERED: "unregistered", // 410 — token is permanently dead, delete it
  BAD_TOKEN: "bad_token", // 400 BadDeviceToken/NotForTopic — token OR our env is wrong; never delete
  AUTH_FAILED: "auth_failed", // 401/403 — provider credential problem
  REJECTED: "rejected", // other 4xx — a bug in what we sent
  UNAVAILABLE: "unavailable", // 429/5xx — transient, safe to retry later
  TIMEOUT: "timeout", // deadline expired
  ERROR: "error", // transport threw
  SKIPPED: "skipped", // status 0 — APNs unconfigured (noop transport)
};

// 410 always means "this token is gone" (app uninstalled / restored onto a
// new device). It is the ONLY status that may delete a token.
//
// `400 BadDeviceToken` used to be treated the same way, and that was a
// destructive mistake. Apple returns it for two very different things:
//
//   (a) the token is genuinely not a valid device token, and
//   (b) the token is perfectly valid but belongs to the OTHER APNs
//       environment — a production (TestFlight/App Store) token sent to
//       api.sandbox.push.apple.com, or the reverse.
//
// (b) is a server misconfiguration, and treating it as (a) means one wrong
// APNS_HOST silently deletes every push token of every account, permanently,
// with each device only recoverable by reinstalling or relaunching the app.
// That is exactly what happened on 2026-08-13: APNS_HOST was left at
// api.sandbox.push.apple.com, the owner installed a TestFlight (production)
// build, and its token was deleted on the first push after each registration —
// twice, within four minutes, so no notification could ever arrive.
//
// `DeviceTokenNotForTopic` is the same shape of ambiguity: it means the token
// does not match `apns-topic`, which is at least as likely to be our bundle id
// being wrong as the device being stale.
//
// Both are now classified BAD_TOKEN: counted, alerted on — because at scale
// they are the signature of a misconfigured environment — but never deleted.
// A device whose app is really gone still gets cleaned up, by the 410 that
// Apple sends for precisely that case.
const AMBIGUOUS_TOKEN_400_REASONS = new Set([
  "BadDeviceToken",
  "DeviceTokenNotForTopic",
]);

// A 400 whose reason literally says the token is no longer registered. Unlike
// the two above this is not environment-dependent, so it keeps 410's meaning.
const UNREGISTERED_400_REASONS = new Set(["Unregistered"]);

const TIMEOUT_SENTINEL = Symbol("apns_timeout");

// The alert dictionary for a mutable push.
//
// The fallback is real words, not a loc-key. This used to send
// {"loc-key":"RELAY_EVENT"} on the assumption that a Notification Service
// Extension would rewrite it; there is no such extension, and iOS renders an
// unresolvable loc-key verbatim — so users' lock screens read "RELAY_EVENT".
// A fallback that only fires on a caller bug is exactly the one nobody sees
// until it is in front of a user, so it says something a human can act on.
function apsAlert(banner) {
  const title = typeof banner?.title === "string" && banner.title.trim()
    ? banner.title.trim()
    : "Relay";
  const body = typeof banner?.body === "string" && banner.body.trim()
    ? banner.body.trim()
    : null;
  return body ? { title, body } : { title };
}

export function createApnsClient({ config, transport, now = () => Date.now() }) {
  const { keyId, teamId, bundleId, signingKeyPem, host } = config.apns;
  // Deliberately the SAME predicate main.js uses to choose the noop transport,
  // called rather than re-derived. When these two drift, an unconfigured
  // deployment picks the noop transport (so it believes it is safe) while the
  // client still tries to mint a provider JWT — which is exactly the bug this
  // guard exists to close.
  const credentialsPresent = apnsConfigured(config);
  let cachedToken = null;
  let cachedAt = 0;

  function providerToken() {
    if (cachedToken && now() - cachedAt < PROVIDER_TOKEN_TTL_MS) {
      return cachedToken;
    }
    const header = b64urlJson({ alg: "ES256", kid: keyId });
    const claims = b64urlJson({ iss: teamId, iat: Math.floor(now() / 1000) });
    const key = createPrivateKey(signingKeyPem);
    const sig = cryptoSign("SHA256", Buffer.from(`${header}.${claims}`), {
      key,
      dsaEncoding: "ieee-p1363", // JOSE raw r||s, not DER
    }).toString("base64url");
    cachedToken = `${header}.${claims}.${sig}`;
    cachedAt = now();
    return cachedToken;
  }

  // The APNs host a given device's token is valid against.
  //
  // A token only works against the environment of the build that minted it: a
  // TestFlight/App Store token against api.push.apple.com, a development
  // build's against api.sandbox.push.apple.com. Sent to the wrong one Apple
  // answers `400 BadDeviceToken`, which looks exactly like a dead token.
  //
  // With one global host, an account could not hold both kinds — and on
  // 2026-08-13 that cost the owner every token they had, because BadDeviceToken
  // was being treated as "the app is gone". `host` remains the configured
  // default and is what an unknown environment still uses, so a device that
  // never reported one behaves exactly as before.
  function hostFor(apnsEnvironment) {
    if (apnsEnvironment === "production") return "api.push.apple.com";
    if (apnsEnvironment === "development") return "api.sandbox.push.apple.com";
    return host;
  }

  // Read per call, not at construction: the deadline is operational tuning,
  // not identity, and tests need to shorten it without rebuilding the app.
  function timeoutMs() {
    const configured = Number(config.apns.requestTimeoutMs);
    return Number.isFinite(configured) && configured > 0
      ? configured
      : DEFAULT_APNS_TIMEOUT_MS;
  }

  // kind: "silent" (background state sync) or "mutable" (user-visible).
  // banner: {title, body} for a mutable push — see notify.js's bannerFor, which
  //   is the single place that decides what a user reads and what therefore
  //   becomes visible to Apple. Ignored for silent pushes.
  // Resolves to {outcome, status, reason} — see APNS_OUTCOME. Never rejects.
  async function send({ deviceToken, kind, category, payload, collapseId, banner, apnsEnvironment }) {
    // BEFORE any JWT work, and the reason is the header block below: it
    // interpolates providerToken() while building `headers`, which happens
    // outside the try/catch that guards the transport. With no signing key,
    // createPrivateKey("") throws OpenSSL's "DECODER routines::unsupported"
    // straight out of send() — breaking the contract stated at the top of this
    // file that send() NEVER throws, and defeating the noop transport entirely,
    // because the token is minted before the transport is ever consulted.
    //
    // Observed in production: the process logged "APNs credentials unset —
    // pushes will be skipped" at boot and then threw "apns send threw:
    // error:1E08010C:DECODER routines::unsupported" on the first real push.
    // The skip was never real. Returning the same shape classify() produces
    // for status 0 keeps callers on the one code path they already handle.
    if (!credentialsPresent) {
      return { outcome: APNS_OUTCOME.SKIPPED, status: 0, reason: null };
    }

    const aps =
      kind === "silent"
        ? { "content-available": 1 }
        : {
            alert: apsAlert(banner),
            // Kept set even though nothing rewrites the banner today: a
            // Notification Service Extension added later can replace this text
            // with something fetched from the node over mTLS, at which point
            // the names can come back out of the payload.
            "mutable-content": 1,
            category: category || "RELAY_EVENT",
          };
    const body = JSON.stringify({ aps, relay: payload });
    const headers = {
      authorization: `bearer ${providerToken()}`,
      "apns-topic": bundleId,
      "apns-push-type": kind === "silent" ? "background" : "alert",
      "apns-priority": kind === "silent" ? "5" : "10",
      "apns-expiration": String(Math.floor(now() / 1000) + 3600),
      "content-type": "application/json",
    };
    if (collapseId) headers["apns-collapse-id"] = collapseId;

    const controller = new AbortController();
    let timer = null;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        try {
          controller.abort();
        } catch {
          /* already aborted */
        }
        reject(TIMEOUT_SENTINEL);
      }, timeoutMs());
    });

    let response;
    try {
      const attempt = transport({
        host: hostFor(apnsEnvironment),
        path: `/3/device/${deviceToken}`,
        headers,
        body,
        signal: controller.signal,
      });
      // A transport that loses the race can still reject later; without this
      // the late rejection surfaces as an unhandledRejection and can take the
      // process down. The race registered its handler first, so this does not
      // swallow a rejection the caller needed.
      if (attempt && typeof attempt.catch === "function") attempt.catch(() => {});
      response = await Promise.race([attempt, deadline]);
    } catch (err) {
      if (err === TIMEOUT_SENTINEL) {
        return { outcome: APNS_OUTCOME.TIMEOUT, status: 0, reason: null };
      }
      return {
        outcome: APNS_OUTCOME.ERROR,
        status: 0,
        reason: null,
        error: String(err?.message ?? err),
      };
    } finally {
      clearTimeout(timer);
    }
    return classify(response);
  }

  function classify(response) {
    const status = Number(response?.status ?? 0);
    const reason = reasonOf(response?.body);
    if (status === 200) {
      return { outcome: APNS_OUTCOME.DELIVERED, status, reason: null };
    }
    if (status === 0) {
      return { outcome: APNS_OUTCOME.SKIPPED, status, reason };
    }
    if (status === 410 || (status === 400 && UNREGISTERED_400_REASONS.has(reason))) {
      return { outcome: APNS_OUTCOME.UNREGISTERED, status, reason };
    }
    if (status === 400 && AMBIGUOUS_TOKEN_400_REASONS.has(reason)) {
      return { outcome: APNS_OUTCOME.BAD_TOKEN, status, reason };
    }
    if (status === 401 || status === 403) {
      // The provider JWT is cached for 45 minutes. If Apple is refusing it,
      // caching it for another 45 minutes guarantees 45 more minutes of total
      // push failure — drop it so the next send re-mints.
      cachedToken = null;
      cachedAt = 0;
      return { outcome: APNS_OUTCOME.AUTH_FAILED, status, reason };
    }
    if (status === 429 || status >= 500) {
      return { outcome: APNS_OUTCOME.UNAVAILABLE, status, reason };
    }
    return { outcome: APNS_OUTCOME.REJECTED, status, reason };
  }

  return { send };
}

// Apple's error bodies are {"reason":"BadDeviceToken"} (410 adds a
// "timestamp"). Anything unparseable yields null rather than throwing.
function reasonOf(body) {
  if (!body) return null;
  if (typeof body === "object") {
    return typeof body.reason === "string" ? body.reason : null;
  }
  if (typeof body !== "string") return null;
  try {
    const parsed = JSON.parse(body);
    return typeof parsed?.reason === "string" ? parsed.reason : null;
  } catch {
    return null;
  }
}

// Production transport over node:http2. One connection per push; pooling is a
// productionization item — but the connection is torn down on EVERY exit path
// (response, stream error, session error, deadline, abort). A leaked session
// holds a TLS socket and a libuv handle open forever, so a transient APNs
// hiccup used to turn into a permanent fd leak that outlived the push.
//
// `connect` is injectable so the lifecycle can be tested without a real TLS
// peer; production passes nothing and gets node:http2.
export function createHttp2Transport({
  connect,
  connectOptions,
  timeoutMs = DEFAULT_APNS_TIMEOUT_MS,
} = {}) {
  let connectFn = connect ?? null;
  return async ({ host, path, headers, body, signal }) => {
    if (!connectFn) ({ connect: connectFn } = await import("node:http2"));
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer = null;
      let client = null;
      let req = null;

      const finish = (err, value) => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        if (signal) {
          try {
            signal.removeEventListener("abort", onAbort);
          } catch {
            /* non-standard signal */
          }
        }
        // destroy(), not close(): close() waits for a GOAWAY the peer may
        // never send. The response body is already fully buffered by the time
        // we get here, so there is nothing to lose by tearing the socket down.
        try {
          req?.close?.();
        } catch {
          /* stream already gone */
        }
        try {
          client?.destroy();
        } catch {
          /* session already gone */
        }
        if (err) reject(err);
        else resolve(value);
      };
      const onAbort = () => finish(new Error("apns_request_aborted"));

      timer = setTimeout(() => finish(new Error("apns_request_timeout")), timeoutMs);
      if (signal) {
        if (signal.aborted) return finish(new Error("apns_request_aborted"));
        try {
          signal.addEventListener("abort", onAbort, { once: true });
        } catch {
          /* non-standard signal */
        }
      }

      try {
        client = connectFn(`https://${host}`, connectOptions);
      } catch (err) {
        return finish(err);
      }
      client.on("error", (err) => finish(err));
      client.on("close", () => finish(new Error("apns_session_closed")));

      try {
        req = client.request({ ":method": "POST", ":path": path, ...headers });
      } catch (err) {
        return finish(err);
      }

      let status = 0;
      let responseHeaders = {};
      const chunks = [];
      req.on("response", (h) => {
        status = Number(h[":status"]) || 0;
        responseHeaders = { ...h };
      });
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        finish(null, {
          status,
          headers: responseHeaders,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
      req.on("error", (err) => finish(err));
      req.end(body);
    });
  };
}

// Used when APNs credentials are not configured: records nothing sensitive,
// reports skipped sends (status 0 → APNS_OUTCOME.SKIPPED, never "delivered").
export function createNoopTransport(log = () => {}) {
  return async ({ host, path }) => {
    log(`apns skipped (unconfigured): ${host}${path.slice(0, 16)}…`);
    return { status: 0, headers: {}, body: "" };
  };
}

export function apnsConfigured(config) {
  const { keyId, teamId, bundleId, signingKeyPem } = config.apns;
  return Boolean(keyId && teamId && bundleId && signingKeyPem);
}
