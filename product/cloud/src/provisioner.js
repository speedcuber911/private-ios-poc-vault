// E2B-protocol sandbox provisioner. Works against a self-hosted Cube host
// today and hosted e2b later — only the endpoint and key change. The API
// key is a server-side secret: it never appears in logs or responses.

export function createProvisioner(config) {
  const { apiUrl, apiKey, templateId } = config.e2b;
  if (!apiUrl) return null;

  // Every call is bounded. Node's fetch has NO default timeout, so a Cube host
  // that accepts the connection and then stops responding would otherwise hang
  // the caller forever — which for `sweepTrials` means the reaper's `for` loop
  // never reaches the next trial and no later pass ever runs, with nothing to
  // detect it (the sweep is fire-and-forget). The signal covers the response
  // body as well as the headers, so a stalled body cannot slip past it.
  async function call(method, path, body) {
    const res = await fetch(`${apiUrl}${path}`, {
      method,
      headers: {
        "x-api-key": apiKey,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(config.trial.provisionerTimeoutMs),
    });
    return res;
  }

  return {
    async createSandbox({ envVars = {}, metadata = {} } = {}) {
      // SECONDS. Cube forwards this field unconverted into
      // `context.WithTimeout(ctx, timeout * time.Second)`, and treats absent or
      // zero as its own 60-second default — a machine that dies a minute after
      // the user signs up. So the value is validated here rather than trusted:
      // an unusable timeout is a create failure, never a silently short-lived
      // sandbox. config.trial.sandboxTimeoutSec is derived from ttl + grace so
      // this acts as the orphan backstop, not a premature killer.
      const timeoutSec = config.trial.sandboxTimeoutSec;
      if (!Number.isFinite(timeoutSec) || timeoutSec < 1) {
        throw new Error("provisioner_invalid_timeout");
      }
      const res = await call("POST", "/sandboxes", {
        templateID: templateId,
        timeout: timeoutSec,
        envVars,
        metadata,
      });
      if (!res.ok) throw new Error(`provisioner_http_${res.status}`);
      const json = await res.json();
      // A create response we cannot extract an id from means a live sandbox
      // nothing can reference: the reaper only pauses/kills when
      // `trial.sandboxId` is set, so recording `undefined` (which
      // updateTrial's `!== undefined` filter silently skips) would leak the
      // machine for its entire platform timeout. Fail the create instead, so
      // the row lands in `failed` and the account can retry. The sandbox
      // carries `metadata.trialId`, so a Cube-list-vs-`trial_nodes`
      // reconciliation sweep remains the backstop for this window.
      const sandboxId = typeof json?.sandboxID === "string" ? json.sandboxID.trim() : "";
      if (!sandboxId) throw new Error("provisioner_missing_sandbox_id");
      return { sandboxId };
    },

    async killSandbox(sandboxId) {
      const res = await call("DELETE", `/sandboxes/${encodeURIComponent(sandboxId)}`);
      if (res.status === 404) return false;
      if (!res.ok && res.status !== 204) throw new Error(`provisioner_http_${res.status}`);
      return true;
    },

    async pauseSandbox(sandboxId) {
      const res = await call("POST", `/sandboxes/${encodeURIComponent(sandboxId)}/pause`);
      if (res.status === 404) return false;
      if (!res.ok && res.status !== 204) throw new Error(`provisioner_http_${res.status}`);
      return true;
    },
  };
}
