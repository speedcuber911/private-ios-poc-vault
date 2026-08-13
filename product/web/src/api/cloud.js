// Cookie-credential fetch to the Relay control plane.
// Origin comes from VITE_RELAY_CLOUD_URL so this SPA is not pinned to one host.

import { createAuthClient } from "better-auth/client";
import { usernameClient } from "better-auth/client/plugins";

function envCloudUrl() {
  const env =
    typeof import.meta !== "undefined" && import.meta.env
      ? import.meta.env
      : typeof process !== "undefined"
        ? process.env
        : {};
  return String(
    env.VITE_RELAY_CLOUD_URL || "https://relay.ai-rocket-experiments.com",
  ).replace(/\/$/, "");
}

export function cloudBaseUrl() {
  return envCloudUrl();
}

export function createCloud({
  baseUrl = envCloudUrl(),
  fetchImpl = globalThis.fetch.bind(globalThis),
} = {}) {
  const root = String(baseUrl || "").replace(/\/$/, "");

  async function cloudFetch(path, { method = "GET", body, headers } = {}) {
    const init = {
      method,
      credentials: "include",
      headers: {
        accept: "application/json",
        ...headers,
      },
    };
    if (body !== undefined) {
      init.headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const res = await fetchImpl(`${root}${path}`, init);
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

  function signUp({ email, username, password }) {
    return cloudFetch("/api/auth/sign-up/email", {
      method: "POST",
      body: { email, username, password, name: username },
    });
  }

  function signIn({ username, password }) {
    return cloudFetch("/api/auth/sign-in/username", {
      method: "POST",
      body: { username, password },
    });
  }

  const authClient = createAuthClient({
    baseURL: root,
    basePath: "/api/auth",
    credentials: "include",
    fetchOptions: {
      credentials: "include",
      customFetchImpl: fetchImpl,
    },
    plugins: [usernameClient()],
  });

  return { baseUrl: root, cloudFetch, signUp, signIn, authClient };
}

export const cloud = createCloud();
