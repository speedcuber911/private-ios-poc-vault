// A browse root of "/" must not reject everything underneath it.
//
// The containment guard was spelled `candidate.startsWith(root + path.sep)`,
// which is correct for every root except the filesystem root: "/" + "/" is
// "//", and no real path begins with that. So a machine whose owner asked for
// whole-disk access could list "/" — that hit the `candidate === root` arm —
// and nothing below it. Every folder tapped in the phone's browser came back
//
//   HTTP 400: workspace path must stay inside the workspace root
//
// which reads like a permissions or jail problem and is neither. Reported from
// the owner's own machine on 2026-09-09, right after CODEX_WORKSPACE_BROWSE_ROOT
// was widened to "/" so the browser could show the whole box.
//
// The trailing separator is still what stops "/home/ubuntu-evil" from passing
// as "/home/ubuntu", so these tests pin BOTH halves: "/" admits its children,
// and a sibling whose name merely starts with the root's name stays out.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CONFIG = fileURLToPath(new URL("../src/config.mjs", import.meta.url));

// config.mjs creates directories at import time, so it loads in a child against
// a throwaway data dir rather than this process's real one.
function containmentUnder(browseRoot, candidates) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-browse-root-"));
  try {
    const script =
      `import { pathWithinRoot, workspaceBrowseRoot } from ${JSON.stringify(CONFIG)};` +
      `const candidates = ${JSON.stringify(candidates)};` +
      `process.stdout.write(JSON.stringify({` +
      `  root: workspaceBrowseRoot,` +
      `  results: candidates.map((c) => pathWithinRoot(c, workspaceBrowseRoot)),` +
      `}));`;
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, CODEX_DATA_DIR: dataDir, CODEX_WORKSPACE_BROWSE_ROOT: browseRoot },
      encoding: "utf8",
    });
    return JSON.parse(out);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

test("a browse root of / admits every path beneath it", () => {
  const candidates = ["/", "/dev", "/home/ubuntu", "/home/ubuntu/Shiprocket", "/srv/codex-workspaces"];
  const { root, results } = containmentUnder("/", candidates);

  assert.equal(root, "/", "precondition: the root really is the filesystem root");
  for (const [index, candidate] of candidates.entries()) {
    assert.equal(results[index], true, `${candidate} is inside / and must list`);
  }
});

test("a nested browse root still rejects siblings that share its prefix", () => {
  // realpath: config.mjs resolves the browse root, and on macOS the temp dir
  // is a symlink (/var/folders -> /private/var/folders). Comparing an
  // unresolved candidate against a resolved root fails for that reason alone.
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relayd-nested-root-")));
  try {
    const root = path.join(base, "workspace");
    fs.mkdirSync(root);
    // Same parent, name starts with the root's name: the exact case the
    // trailing separator exists to reject.
    fs.mkdirSync(`${root}-evil`);
    fs.mkdirSync(path.join(root, "inside"));

    const candidates = [root, path.join(root, "inside"), `${root}-evil`, path.join(`${root}-evil`, "x")];
    const { results } = containmentUnder(root, candidates);

    assert.equal(results[0], true, "the root itself is inside itself");
    assert.equal(results[1], true, "a real child is inside");
    assert.equal(results[2], false, "a prefix-sharing sibling must never pass");
    assert.equal(results[3], false, "nor anything under it");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
