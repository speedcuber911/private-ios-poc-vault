// Request logger for the grant gateway.
//
// The gateway must never hand response bodies to a logger. createLogger also
// drops any `body` / `response` / `responseBody` / `upstreamBody` field so a
// mistaken caller cannot print activity payloads.

const DROP = new Set(["body", "response", "responseBody", "upstreamBody"]);

export function createLogger(write = (line) => console.error(line)) {
  return function log(event) {
    if (event == null) return;
    if (typeof event !== "object") {
      write(String(event));
      return;
    }
    const safe = {};
    for (const [key, value] of Object.entries(event)) {
      if (DROP.has(key)) continue;
      safe[key] = value;
    }
    write(JSON.stringify(safe));
  };
}
