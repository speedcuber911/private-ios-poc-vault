// E2B-protocol sandbox provisioner. Works against a self-hosted Cube host
// today and hosted e2b later — only the endpoint and key change. The API
// key is a server-side secret: it never appears in logs or responses.

export function createProvisioner(config) {
  const { apiUrl, apiKey, templateId } = config.e2b;
  if (!apiUrl) return null;

  async function call(method, path, body) {
    const res = await fetch(`${apiUrl}${path}`, {
      method,
      headers: {
        "x-api-key": apiKey,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return res;
  }

  return {
    async createSandbox({ envVars = {}, metadata = {} } = {}) {
      const res = await call("POST", "/sandboxes", {
        templateID: templateId,
        timeout: config.trial.sandboxTimeoutMs,
        envVars,
        metadata,
      });
      if (!res.ok) throw new Error(`provisioner_http_${res.status}`);
      const json = await res.json();
      return { sandboxId: json.sandboxID };
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
