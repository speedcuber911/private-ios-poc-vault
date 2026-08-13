import test from "node:test";
import assert from "node:assert/strict";
import { startTestApp } from "./helpers.mjs";
import { loadConfig, webOriginsRequireHttps } from "../src/config.js";

test("trustedOrigins includes RELAY_WEB_ORIGINS", async () => {
  const t = await startTestApp({
    env: { RELAY_WEB_ORIGINS: "https://app.example.test" },
  });
  try {
    assert.ok(t.config.trustedWebOrigins.includes("https://app.example.test"));
  } finally {
    await t.close();
  }
});

test("RELAY_WEB_ORIGINS with a non-https BETTER_AUTH_URL is a startup error", () => {
  const config = loadConfig({
    RELAY_WEB_ORIGINS: "https://app.example.test",
    BETTER_AUTH_URL: "http://127.0.0.1:8790",
  });
  assert.equal(webOriginsRequireHttps(config), true);
});

test("RELAY_WEB_ORIGINS with https BETTER_AUTH_URL is allowed", () => {
  const config = loadConfig({
    RELAY_WEB_ORIGINS: "https://app.example.test",
    BETTER_AUTH_URL: "https://api.example.test",
  });
  assert.equal(webOriginsRequireHttps(config), false);
});

test("unset RELAY_WEB_ORIGINS does not require https BETTER_AUTH_URL", () => {
  const config = loadConfig({
    BETTER_AUTH_URL: "http://127.0.0.1:8790",
  });
  assert.equal(webOriginsRequireHttps(config), false);
});
