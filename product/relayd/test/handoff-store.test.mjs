import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.CODEX_DATA_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), "relayd-handoffstore-data-"));

const { createStore } = await import("../src/store.mjs");

function record(overrides = {}) {
  return {
    id: "abc123def4567890", state: "ready", repo: "me/relay", branch: "relay/handoff-x",
    workspaceId: "dir-handoff-abc123", provider: "claude",
    resumeSessionId: "11111111-2222-4333-8444-555555555555", primedPrompt: null,
    title: "Fix the auth redirect", manifest: { v: 1, title: "Fix the auth redirect" },
    lastJobId: null, error: null, createdAt: "2026-08-11T10:00:00.000Z", updatedAt: "2026-08-11T10:00:00.000Z",
    ...overrides,
  };
}

for (const kind of ["json", "sqlite"]) {
  test(`${kind}: handoffs round-trip and list newest first`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `relayd-handoffstore-${kind}-`));
    const store = await createStore(kind, {
      jobsDir: path.join(dir, "jobs"), chatsDir: path.join(dir, "chats"),
      dataDir: dir, pairingDir: path.join(dir, "pairing"), dbPath: path.join(dir, "relayd.sqlite"),
    });
    try {
      store.saveHandoff(record({ id: "aaaaaaaaaaaaaaa1", createdAt: "2026-08-11T10:00:00.000Z" }));
      store.saveHandoff(record({ id: "aaaaaaaaaaaaaaa2", createdAt: "2026-08-11T11:00:00.000Z" }));

      const fetched = store.getHandoff("aaaaaaaaaaaaaaa1");
      assert.equal(fetched.title, "Fix the auth redirect");
      assert.deepEqual(fetched.manifest, { v: 1, title: "Fix the auth redirect" });
      assert.deepEqual(store.listHandoffs().map((entry) => entry.id), ["aaaaaaaaaaaaaaa2", "aaaaaaaaaaaaaaa1"]);
    } finally { store.close?.(); }
  });

  test(`${kind}: saving the same id updates in place`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `relayd-handoffupd-${kind}-`));
    const store = await createStore(kind, {
      jobsDir: path.join(dir, "jobs"), chatsDir: path.join(dir, "chats"),
      dataDir: dir, pairingDir: path.join(dir, "pairing"), dbPath: path.join(dir, "relayd.sqlite"),
    });
    try {
      store.saveHandoff(record({ state: "importing" }));
      store.saveHandoff(record({ state: "failed", error: "clone_failed" }));

      assert.equal(store.listHandoffs().length, 1);
      assert.deepEqual(
        { state: store.getHandoff("abc123def4567890").state, error: store.getHandoff("abc123def4567890").error },
        { state: "failed", error: "clone_failed" },
      );
    } finally { store.close?.(); }
  });

  test(`${kind}: an unknown id reads back as null`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `relayd-handoffmiss-${kind}-`));
    const store = await createStore(kind, {
      jobsDir: path.join(dir, "jobs"), chatsDir: path.join(dir, "chats"),
      dataDir: dir, pairingDir: path.join(dir, "pairing"), dbPath: path.join(dir, "relayd.sqlite"),
    });
    try {
      assert.equal(store.getHandoff("nope0000nope0000"), null);
      assert.deepEqual(store.listHandoffs(), []);
    } finally { store.close?.(); }
  });
}
