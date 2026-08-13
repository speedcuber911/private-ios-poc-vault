import test from "node:test";
import assert from "node:assert/strict";
import { startTestApp } from "./helpers.mjs";

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
