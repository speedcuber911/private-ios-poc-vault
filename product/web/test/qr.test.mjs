import test from "node:test";
import assert from "node:assert/strict";
import { qrModules } from "../src/api/qr.js";
import { qrPayloadFromStart } from "../src/api/device.js";

function finderOk(modules, ox, oy) {
  for (let y = 0; y < 7; y++) {
    for (let x = 0; x < 7; x++) {
      const ring = x === 0 || x === 6 || y === 0 || y === 6;
      const center = x >= 2 && x <= 4 && y >= 2 && y <= 4;
      if (modules[oy + y][ox + x] !== (ring || center)) return false;
    }
  }
  return true;
}

test("QR for verificationUriComplete has finder patterns and is not the deviceCode", () => {
  const start = {
    deviceCode: "secret-device-code-never-in-qr",
    userCode: "ABCD-EFGH",
    verificationUriComplete: "https://app.example/cli-login#code=ABCD-EFGH",
  };
  const payload = qrPayloadFromStart(start);
  assert.equal(payload.includes(start.deviceCode), false);
  const modules = qrModules(payload);
  const n = modules.length;
  assert.ok(finderOk(modules, 0, 0), "top-left finder");
  assert.ok(finderOk(modules, n - 7, 0), "top-right finder");
  assert.ok(finderOk(modules, 0, n - 7), "bottom-left finder");
  const leaked = qrModules(start.deviceCode);
  assert.notDeepEqual(modules, leaked);
});
