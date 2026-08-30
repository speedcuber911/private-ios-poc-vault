import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSamplePreviewServer } from "../src/sample-preview-server.mjs";
import { freePort, waitForServer, watchChild } from "../../relayd/test/helpers/wait.mjs";

const seedModule = new URL("../src/seed-sample-workspace.mjs", import.meta.url).href;
const storeModule = new URL("../../relayd/src/store.mjs", import.meta.url).href;
const serverEntry = fileURLToPath(new URL("../../relayd/src/index.mjs", import.meta.url));
const sampleFile = fileURLToPath(new URL("../sample/launch-checklist.html", import.meta.url));

for (const storeKind of ["json", "sqlite"]) {
  test(`preloaded sample survives real ${storeKind} store restart and authenticated relayd routes`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-sample-http-"));
    const dataDir = path.join(root, "data");
    const workspaceRoot = path.join(root, "workspaces");
    const runHome = path.join(root, "home");
    fs.mkdirSync(dataDir);
    fs.mkdirSync(workspaceRoot);
    fs.mkdirSync(runHome);
    const providerMarker = path.join(root, "provider-was-invoked");
    const providerGuard = path.join(root, "provider-guard");
    fs.writeFileSync(providerGuard, `#!/bin/sh\nprintf invoked > '${providerMarker}'\nexit 99\n`, { mode: 0o700 });
    const token = crypto.randomBytes(32).toString("hex");
    const tokenHashFile = path.join(dataDir, "device-token.sha256");
    fs.writeFileSync(tokenHashFile, crypto.createHash("sha256").update(token).digest("hex"), { mode: 0o600 });
    // Deliberately do not inherit the operator's environment, identities or
    // provider binaries. Every process and persisted file belongs to this test.
    const env = {
      PATH: process.env.PATH,
      HOME: runHome,
      CODEX_RUN_HOME: runHome,
      CODEX_DATA_DIR: dataDir,
      CODEX_WORKSPACE_BROWSE_ROOT: workspaceRoot,
      CODEX_WORKSPACES: JSON.stringify([{ id: "welcome", name: "Welcome", path: path.join(workspaceRoot, "welcome") }]),
      CODEX_BIN: providerGuard, CLAUDE_BIN: providerGuard, CURSOR_BIN: providerGuard, KIMI_BIN: providerGuard,
      CODEX_REQUIRE_MTLS: "true",
      RELAYD_DEVICE_TOKEN_HASH_FILE: tokenHashFile,
      RELAYD_STORE: storeKind,
      RELAYD_PAIRING_ENABLED: "false",
      RELAYD_HANDOFF_ENABLED: "false",
    };
    let preview;
    let child;
    try {
      // A separate process writes and closes the real store, just as start.sh
      // does before the long-running daemon opens it.
      const seeded = spawnSync(process.execPath, ["--input-type=module", "-e", `
        import { seedSampleWorkspace } from ${JSON.stringify(seedModule)};
        const { store } = await import(${JSON.stringify(storeModule)});
        try {
          const result = await seedSampleWorkspace({ dataDir: process.env.CODEX_DATA_DIR,
            workspaceRoot: process.env.CODEX_WORKSPACE_BROWSE_ROOT,
            htmlPath: ${JSON.stringify(sampleFile)}, store });
          console.log(JSON.stringify(result));
        } finally { store.close?.(); }
      `], { env, encoding: "utf8", timeout: 10_000 });
      assert.equal(seeded.status, 0, seeded.stderr || String(seeded.error));
      const { status, jobId } = JSON.parse(seeded.stdout);
      assert.equal(status, "seeded");

      preview = createSamplePreviewServer(workspaceRoot);
      await new Promise((resolve, reject) => {
        preview.once("error", reject);
        preview.listen(0, "127.0.0.1", resolve);
      });
      const sourceURL = `http://localhost:${preview.address().port}/lab`;
      // The production source is a fixed loopback port. Remap only this test's
      // stored URL to the kernel-selected listener so parallel tests never
      // claim a developer's port 4317. All real store and route code is used.
      const remapped = spawnSync(process.execPath, ["--input-type=module", "-e", `
        import fs from "node:fs";
        import assert from "node:assert/strict";
        const { store } = await import(${JSON.stringify(storeModule)});
        try {
          const records = store.loadJobRecords();
          assert.equal(records.length, 1);
          const job = records[0].job;
          assert.ok(job.result.includes("http://localhost:4317/lab"));
          assert.equal(job.sampleOrigin, "relay-starter-v1");
          job.result = job.result.replace("http://localhost:4317/lab", ${JSON.stringify(sourceURL)});
          fs.writeFileSync(job.resultPath, job.result);
          store.saveJob(job);
        } finally { store.close?.(); }
      `], { env, encoding: "utf8", timeout: 10_000 });
      assert.equal(remapped.status, 0, remapped.stderr || String(remapped.error));

      const port = await freePort();
      child = spawn(process.execPath, [serverEntry], {
        env: { ...env, CODEX_API_HOST: "127.0.0.1", CODEX_API_PORT: String(port) },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const watch = watchChild(child, `relayd(sample:${storeKind})`);
      const base = `http://127.0.0.1:${port}`;
      await waitForServer(base, { exited: watch.exited, output: watch.output });
      const headers = { authorization: `Bearer ${token}` };
      const get = pathname => fetch(`${base}${pathname}`, { headers });
      assert.equal((await fetch(`${base}/v1/codex/jobs`)).status, 401);
      const listed = await get("/v1/codex/jobs?limit=100");
      assert.equal(listed.status, 200);
      const { jobs } = await listed.json();
      assert.equal(jobs.length, 1);
      const job = jobs[0];
      assert.equal(job.id, jobId);
      assert.equal(job.status, "succeeded");
      assert.equal(job.workspaceId, "dir-launch-checklist");
      assert.equal(job.workspaceName, "Launch checklist");
      assert.match(job.prompt, /Preloaded example/);
      assert.match(job.model, /no AI call/);
      assert.match(job.resultPreview, /not an AI-generated run; no provider call was made/);
      assert.ok(job.resultPreview.includes(sourceURL));
      assert.equal(job.startedAt, null);
      assert.equal(job.execution, null);
      assert.equal(job.sessionId, null);
      assert.equal(job.artifacts.length, 1);
      assert.equal(job.artifacts[0].kind, "staticPreview");
      const scoped = await get("/v1/codex/jobs?workspaceId=dir-launch-checklist");
      assert.equal(scoped.status, 200, "the seeded dynamic workspace must resolve after restart");
      assert.equal((await scoped.json()).jobs[0].id, jobId);
      const detail = await get(`/v1/codex/jobs/${jobId}`);
      assert.equal(detail.status, 200);
      assert.match((await detail.json()).result, /Preloaded example/);

      const artifact = job.artifacts[0];
      assert.equal((await fetch(`${base}${artifact.rawURL}`)).status, 401);
      assert.equal((await fetch(`${base}${artifact.previewURL}`)).status, 401);
      const raw = await get(artifact.rawURL);
      assert.equal(raw.status, 200);
      assert.deepEqual(Buffer.from(await raw.arrayBuffer()), fs.readFileSync(sampleFile));
      const staticPreview = await get(artifact.previewURL);
      assert.equal(staticPreview.status, 200);
      assert.match(await staticPreview.text(), /iframe sandbox="allow-scripts"/);

      const leaseRequest = { method: "POST", headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ jobId, url: sourceURL }) };
      assert.equal((await fetch(`${base}/v1/codex/previews`, { ...leaseRequest, headers: { "content-type": "application/json" } })).status, 401);
      const created = await fetch(`${base}/v1/codex/previews`, leaseRequest);
      assert.equal(created.status, 201);
      const lease = await created.json();
      assert.equal((await fetch(`${base}${lease.url}`)).status, 401);
      const wrapper = await get(lease.url);
      assert.equal(wrapper.status, 200);
      const wrapperHTML = await wrapper.text();
      assert.match(wrapperHTML, /sandbox="allow-scripts allow-forms allow-modals"/);
      const capability = wrapperHTML.match(/src="([^"]+\/proxy\/lab)"/)?.[1];
      assert.ok(capability);
      // The iframe uses the short-lived task-bound capability, not the device
      // bearer token. This is the existing authenticated viewer contract.
      const live = await fetch(`${base}${capability}`);
      assert.equal(live.status, 200);
      const html = await live.text();
      assert.match(html, /A calmer path/);
      assert.match(html, /checkbox/);
      assert.match(html, /addEventListener/);
      assert.equal((await fetch(`${base}${lease.url}`, { method: "DELETE", headers })).status, 204);
      assert.equal((await fetch(`${base}${capability}`)).status, 404);
      const health = await (await get("/v1/codex/health")).json();
      assert.equal(health.activeJobs, 0);
      assert.equal(health.queueLength, 0);
      assert.equal(fs.existsSync(providerMarker), false, "no provider process may be invoked by loading/viewing the sample");
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        const stopped = new Promise(resolve => child.once("exit", resolve));
        child.kill("SIGTERM");
        await stopped;
      }
      if (preview?.listening) await new Promise(resolve => preview.close(resolve));
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
