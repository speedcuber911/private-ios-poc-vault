// Browser grants and live activity through the grant gateway.
// On 401, remint once. Never log the grant JWT.

import { cloud as defaultCloud } from "./cloud.js";

export const CANT_REACH_MACHINE = "Can't reach this machine.";
export const NO_RUNS_YET = "No runs yet.";

async function readJson(res) {
  const text = await res.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = { message: text };
    }
  }
  return { ok: res.ok, status: res.status, json };
}

/**
 * @param {{ ok?: boolean, jobs?: unknown[], threads?: unknown[] }} [args]
 */
export function activityCopy({ ok, jobs = [], threads = [] } = {}) {
  if (!ok) return CANT_REACH_MACHINE;
  if ((!jobs || jobs.length === 0) && (!threads || threads.length === 0)) return NO_RUNS_YET;
  return null;
}

export function createGrant({
  cloud = defaultCloud,
  fetchImpl = globalThis.fetch.bind(globalThis),
} = {}) {
  function mintBrowserGrant(nodeId) {
    return cloud.cloudFetch(`/v1/nodes/${nodeId}/browser-grants`, { method: "POST" });
  }

  async function gatewayGet(gatewayUrl, path, grant) {
    const root = String(gatewayUrl || "").replace(/\/$/, "");
    const res = await fetchImpl(`${root}${path}`, {
      method: "GET",
      credentials: "include",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${grant}`,
      },
    });
    return readJson(res);
  }

  /**
   * @param {string} nodeId
   * @returns {Promise<{ ok: true, jobs: object[], threads: object[] } | { ok: false, error: string }>}
   */
  async function loadActivity(nodeId) {
    let minted = await mintBrowserGrant(nodeId);
    if (!minted.ok) return { ok: false, error: CANT_REACH_MACHINE };
    let grant = minted.json?.grant;
    let gatewayUrl = minted.json?.gatewayUrl;
    let reminted = false;

    async function get(path) {
      let res = await gatewayGet(gatewayUrl, path, grant);
      if (res.status === 401 && !reminted) {
        minted = await mintBrowserGrant(nodeId);
        reminted = true;
        if (!minted.ok) return { ok: false, status: minted.status, json: minted.json };
        grant = minted.json?.grant;
        gatewayUrl = minted.json?.gatewayUrl;
        res = await gatewayGet(gatewayUrl, path, grant);
      }
      return res;
    }

    const jobsRes = await get("/activity/jobs");
    const threadsRes = await get("/activity/threads");
    if (!jobsRes.ok || !threadsRes.ok) return { ok: false, error: CANT_REACH_MACHINE };
    return {
      ok: true,
      jobs: jobsRes.json?.jobs || [],
      threads: threadsRes.json?.threads || [],
    };
  }

  return { mintBrowserGrant, loadActivity };
}

export const grant = createGrant();
