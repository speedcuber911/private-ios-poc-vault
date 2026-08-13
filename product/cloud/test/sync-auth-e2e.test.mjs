// Loader for the cross-package credential-sync end-to-end test.
//
// The test body (./sync-auth-e2e.impl.mjs) drives the REAL `relay sync-auth`
// command and the REAL relayd collector against the real cloud server, so it
// imports product/cli and product/relayd by relative path. Those siblings
// exist in the monorepo but NOT in what ships to the server: the deploy
// artifact is product/cloud alone (deploy/cicd-deploy.sh tars this directory),
// and the CodeCommit repo the pipeline builds from mirrors only this package.
//
// So the file had to stop being an unconditional import. It ran green locally
// and failed the deploy in CodeBuild with ERR_MODULE_NOT_FOUND on
// ../../cli/src/commands/syncauth.mjs — blocking the release of every other
// change in the same push.
//
// The guard reports a SKIP naming the missing paths rather than passing
// quietly, because a cross-package test that silently disappears is how the
// gap this test exists to close got in.

import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const SIBLING_MODULES = [
  "cli/src/commands/syncauth.mjs",
  "cli/src/creds.mjs",
  "cli/src/sessions.mjs",
  "relayd/src/syncauth.mjs",
  "relayd/src/identity.mjs",
  "relayd/src/seal.mjs",
];

const productRoot = path.resolve(import.meta.dirname, "..", "..");
const missing = SIBLING_MODULES.filter(
  (rel) => !fs.existsSync(path.join(productRoot, rel)),
);

if (missing.length) {
  test("credential sync end to end", {
    skip:
      "needs sibling packages absent from this checkout " +
      `(${missing.join(", ")}) — runs in the monorepo, not in the ` +
      "product/cloud-only deploy artifact",
  }, () => {});
} else {
  await import("./sync-auth-e2e.impl.mjs");
}
