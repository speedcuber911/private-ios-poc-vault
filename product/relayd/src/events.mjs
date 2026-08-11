// relayd events.mjs — W2-MODULES: in-process event bus + GET /v1/events feed
// (API.md §2.2). The bus is bounded and in-memory; when the SQLite store is
// active, events are additionally persisted to the `events` table so cursors
// survive restarts. No event ever carries prompt/result content beyond the
// documented status payloads.

import { parseIntegerEnv, jobStreamHeartbeatMs } from "./config.mjs";
import { nowIso, sendError, initSse, headerValue } from "./util.mjs";
import { store } from "./store.mjs";
import { tryAcquireStreamSlot, releaseStreamSlot } from "./jobs.mjs";

// Retention: bounded count (API.md targets 10k events max).
const eventsRetention = parseIntegerEnv("RELAYD_EVENTS_RETENTION", 10000, 10, 100000);

const replayBatchSize = 500;

const eventSubscribers = new Set();

const eventLog = [];

let eventCursor = store.kind === "sqlite" ? store.lastEventId() : 0;

function currentEventCursor() {
  return eventCursor;
}

function emitEvent(name, data) {
  const ts = nowIso();
  let id;
  if (store.kind === "sqlite") {
    id = store.appendEvent({ name, ts, data });
    store.pruneEvents(eventsRetention);
    eventCursor = id;
  } else {
    eventCursor += 1;
    id = eventCursor;
  }
  const event = { id, name, ts, data };
  eventLog.push(event);
  if (eventLog.length > eventsRetention) {
    eventLog.splice(0, eventLog.length - eventsRetention);
  }
  for (const subscriber of [...eventSubscribers]) {
    writeEventTo(subscriber, event);
  }
  return event;
}

// Oldest cursor still replayable (0 when nothing was ever emitted).
function oldestRetainedEventId() {
  if (store.kind === "sqlite") {
    const [first] = store.listEvents({ sinceId: 0, limit: 1 });
    return first ? first.id : eventCursor + 1;
  }
  return eventLog.length ? eventLog[0].id : eventCursor + 1;
}

function replayEventsSince(sinceId, limit) {
  if (store.kind === "sqlite") {
    return store.listEvents({ sinceId, limit });
  }
  const events = [];
  for (const event of eventLog) {
    if (event.id > sinceId) {
      events.push(event);
      if (events.length >= limit) break;
    }
  }
  return events;
}

function writeEventTo(subscriber, event) {
  if (subscriber.closed) return;
  try {
    subscriber.res.write(`id: ${event.id}\nevent: ${event.name}\ndata: ${JSON.stringify(event.data)}\n\n`);
  } catch {
    closeEventStream(subscriber);
  }
}

function closeEventStream(subscriber, { end = false } = {}) {
  if (subscriber.closed) return;
  subscriber.closed = true;
  clearInterval(subscriber.heartbeatTimer);
  eventSubscribers.delete(subscriber);
  releaseStreamSlot();
  if (end) {
    try {
      subscriber.res.end();
    } catch {
      // Connection already gone.
    }
  }
}

function cleanSinceCursor(req, searchParams) {
  // Last-Event-ID: <n> is equivalent to ?since=<n> (API.md §2.1/2.2).
  const header = headerValue(req.headers["last-event-id"]).trim();
  const raw = header || (searchParams.get("since") || "").trim();
  if (!raw) return 0;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw Object.assign(new Error("since must be a non-negative integer"), { status: 400 });
  }
  return value;
}

// GET /v1/events?since=<cursor> — node-wide SSE feed. Event grammar per
// API.md §2.2: hello first (current cursor), optional reset when `since`
// fell out of retention, then replayed + live events, each with id: <cursor>.
function streamNodeEvents(req, res, url) {
  const since = cleanSinceCursor(req, url.searchParams);
  if (!tryAcquireStreamSlot()) {
    return sendError(res, 503, "too many concurrent job streams");
  }
  initSse(res);

  const subscriber = { res, closed: false, heartbeatTimer: null };

  try {
    res.write(`id: ${eventCursor}\nevent: hello\ndata: ${JSON.stringify({ cursor: eventCursor, nodeTime: nowIso() })}\n\n`);
  } catch {
    releaseStreamSlot();
    return;
  }

  let replayFrom = since;
  if (since > 0) {
    const oldest = oldestRetainedEventId();
    if (since < oldest - 1) {
      // The requested cursor predates retention: tell the client to resync
      // via the list endpoints, then live-follow only.
      try {
        res.write(`id: ${eventCursor}\nevent: reset\ndata: ${JSON.stringify({ reason: "retention", cursor: eventCursor })}\n\n`);
      } catch {
        releaseStreamSlot();
        return;
      }
      replayFrom = eventCursor;
    }
  } else {
    // since omitted/0 = "now": no replay.
    replayFrom = eventCursor;
  }

  // Bounded replay batches up to the live cursor.
  while (replayFrom < eventCursor && !subscriber.closed) {
    const batch = replayEventsSince(replayFrom, replayBatchSize);
    if (batch.length === 0) break;
    for (const event of batch) {
      writeEventTo(subscriber, event);
    }
    replayFrom = batch[batch.length - 1].id;
  }
  if (subscriber.closed) return;

  eventSubscribers.add(subscriber);

  subscriber.heartbeatTimer = setInterval(() => {
    if (subscriber.closed) return;
    try {
      subscriber.res.write(": heartbeat\n\n");
    } catch {
      closeEventStream(subscriber);
    }
  }, jobStreamHeartbeatMs);
  subscriber.heartbeatTimer.unref();

  req.on("close", () => closeEventStream(subscriber));
}

export {
  eventsRetention,
  emitEvent,
  currentEventCursor,
  oldestRetainedEventId,
  replayEventsSince,
  streamNodeEvents,
};
