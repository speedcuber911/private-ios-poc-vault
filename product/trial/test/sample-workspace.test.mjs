import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { seedSampleWorkspace } from "../src/seed-sample-workspace.mjs";
import { createSamplePreviewServer } from "../src/sample-preview-server.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-starter-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data");
  const workspaceRoot = path.join(root, "workspaces");
  fs.mkdirSync(dataDir); fs.mkdirSync(workspaceRoot);
  const records = [];
  const store = { loadJobRecords: () => records.map(job => ({ job })), saveJob: job => records.push(job) };
  return { root, dataDir, workspaceRoot, records, store, htmlPath: new URL("../sample/launch-checklist.html", import.meta.url) };
}

test("starter is labeled, uses real identical artifact/file bytes, and makes no provider call", async t => {
  const f = fixture(t);
  assert.equal((await seedSampleWorkspace(f)).status, "seeded");
  const job = f.records[0];
  assert.match(job.prompt, /Preloaded example/);
  assert.match(job.result, /no provider call was made/);
  assert.equal(job.startedAt, null);
  assert.equal(job.execution, null);
  assert.equal(job.sessionId, null);
  assert.match(job.result, /http:\/\/localhost:4317\/lab/);
  assert.deepEqual(fs.readFileSync(job.artifacts[0].path), fs.readFileSync(path.join(job.workspacePath, "launch-checklist.html")));
  assert.equal((await seedSampleWorkspace(f)).status, "already_seeded");
  assert.equal(f.records.length, 1);
});

test("existing user folder and symlink are not overwritten", async t => {
  const f = fixture(t);
  const target = path.join(f.workspaceRoot, "Launch checklist");
  fs.symlinkSync(f.root, target);
  assert.equal((await seedSampleWorkspace(f)).status, "workspace_exists");
  assert.equal(f.records.length, 0);
  assert.equal(fs.readlinkSync(target), f.root);
});

test("ordinary user files and edited or removed seeded workspaces are never replaced", async t => {
  const existing = fixture(t);
  const userPath = path.join(existing.workspaceRoot, "Launch checklist");
  fs.mkdirSync(userPath);
  fs.writeFileSync(path.join(userPath, "launch-checklist.html"), "User-owned content");
  assert.equal((await seedSampleWorkspace(existing)).status, "workspace_exists");
  assert.equal(fs.readFileSync(path.join(userPath, "launch-checklist.html"), "utf8"), "User-owned content");
  assert.equal(existing.records.length, 0);

  const seeded = fixture(t);
  await seedSampleWorkspace(seeded);
  const seededPath = path.join(seeded.workspaceRoot, "Launch checklist");
  fs.writeFileSync(path.join(seededPath, "launch-checklist.html"), "User edit");
  assert.equal((await seedSampleWorkspace(seeded)).status, "already_seeded");
  assert.equal(fs.readFileSync(path.join(seededPath, "launch-checklist.html"), "utf8"), "User edit");
  fs.rmSync(seededPath, { recursive: true });
  assert.equal((await seedSampleWorkspace(seeded)).status, "already_seeded");
  assert.equal(fs.existsSync(seededPath), false);
  assert.equal(seeded.records.length, 1);
});

test("unavailable sample assets do not create a workspace or job", async t => {
  const f = fixture(t);
  await assert.rejects(seedSampleWorkspace({ ...f, htmlPath: path.join(f.root, "missing.html") }), { code: "ENOENT" });
  assert.equal(fs.existsSync(path.join(f.workspaceRoot, "Launch checklist")), false);
  assert.equal(f.records.length, 0);
});

test("preview serves only sample HTML, preserves interactivity, and rejects other routes and symlinks", async t => {
  const f = fixture(t);
  await seedSampleWorkspace(f);
  const server = createSamplePreviewServer(f.workspaceRoot);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/lab`);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /sample/i);
  assert.match(html, /checkbox/);
  assert.match(response.headers.get("content-security-policy"), /connect-src 'none'/);
  assert.equal((await fetch(`${base}/README.md`)).status, 404);
  assert.equal((await fetch(`${base}/lab`, { method: "POST" })).status, 404);
  const htmlPath = path.join(f.workspaceRoot, "Launch checklist", "launch-checklist.html");
  fs.unlinkSync(htmlPath); fs.symlinkSync(path.join(f.workspaceRoot, "Launch checklist", "README.md"), htmlPath);
  assert.equal((await fetch(`${base}/lab`)).status, 404);
});

test("simulator and hosted sample content stay byte-identical", () => {
  assert.deepEqual(fs.readFileSync(new URL("../sample/launch-checklist.html", import.meta.url)),
    fs.readFileSync(new URL("../../../ops/fixtures/launch-checklist.html", import.meta.url)));
});

test("startup packages the sample and runs its helpers without blocking normal daemon boot on failure", () => {
  const start = fs.readFileSync(new URL("../start.sh", import.meta.url), "utf8");
  const dockerfile = fs.readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
  assert.match(dockerfile, /^COPY sample \/opt\/relayd\/sample$/m);
  assert.match(start, /if ! run_as_relay node "\$\{BOOT_DIR\}\/src\/seed-sample-workspace\.mjs"; then[\s\S]*?continuing normal startup[\s\S]*?\nfi/);
  assert.match(start, /run_as_relay node "\$\{BOOT_DIR\}\/src\/sample-preview-server\.mjs" &/);
  assert.ok(start.indexOf("src/seed-sample-workspace.mjs") < start.indexOf('exec runuser --preserve-environment'));
});
