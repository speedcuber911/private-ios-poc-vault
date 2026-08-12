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

  // The sqlite table declares state/repo/branch/created_at/updated_at NOT
  // NULL; the json backend used to validate nothing but the id. A record
  // json saved silently could throw a raw sqlite TypeError under
  // RELAYD_STORE=sqlite — including the exact shape handoff.mjs's first
  // persist() call wrote before assertSafeBranch ran (branch straight from
  // an unvalidated network descriptor). One acceptance contract means both
  // backends now agree: same rejection, same error, on every one of these.
  test(`${kind}: both backends agree on a record missing a required field`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `relayd-handoffcontract-${kind}-`));
    const store = await createStore(kind, {
      jobsDir: path.join(dir, "jobs"), chatsDir: path.join(dir, "chats"),
      dataDir: dir, pairingDir: path.join(dir, "pairing"), dbPath: path.join(dir, "relayd.sqlite"),
    });
    try {
      assert.throws(
        () => store.saveHandoff(record({ id: "branchmissing00001", branch: undefined })),
        /handoff branch is invalid/,
      );
      assert.throws(
        () => store.saveHandoff(record({ id: "branchnull000000002", branch: null })),
        /handoff branch is invalid/,
      );
      assert.throws(
        () => store.saveHandoff(record({ id: "stateundefined00001", state: undefined })),
        /handoff state is invalid/,
      );
      assert.throws(
        () => store.saveHandoff(record({ id: "createdatnull000001", createdAt: null })),
        /handoff createdAt is invalid/,
      );
      assert.throws(
        () => store.saveHandoff(record({ id: "stateobject0000001", state: { a: 1 } })),
        /handoff state is invalid/,
      );
      // None of the rejected saves left a record behind.
      assert.deepEqual(store.listHandoffs(), []);
    } finally { store.close?.(); }
  });
}

// Minor-2 from the task-13 review: handoff records carry primedPrompt and
// resumeSessionId (sensitive session data), so the directory should get the
// same private mode pairingSessionsRoot already does — the file mode was
// already 0600, just untested.
test("json: the handoffs directory and its files are private (0700/0600)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-handoffmode-"));
  const store = await createStore("json", {
    jobsDir: path.join(dir, "jobs"), chatsDir: path.join(dir, "chats"),
    dataDir: dir, pairingDir: path.join(dir, "pairing"),
  });
  try {
    store.saveHandoff(record({ id: "modecheck0000001" }));
    const handoffsDir = path.join(dir, "handoffs");
    assert.equal(fs.statSync(handoffsDir).mode & 0o777, 0o700, "handoffs dir must be 0700");
    assert.equal(
      fs.statSync(path.join(handoffsDir, "modecheck0000001.json")).mode & 0o777,
      0o600,
      "handoff file must be 0600",
    );
  } finally { store.close?.(); }
});

// Minor-5 from the task-13 review: json's listHandoffs called `this.getHandoff(...)`,
// which breaks the moment the method is destructured off the store — every
// other list method in this backend calls a closure function instead, never
// `this`.
test("json: listHandoffs does not depend on 'this'", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-handoffunbound-"));
  const store = await createStore("json", {
    jobsDir: path.join(dir, "jobs"), chatsDir: path.join(dir, "chats"),
    dataDir: dir, pairingDir: path.join(dir, "pairing"),
  });
  try {
    store.saveHandoff(record({ id: "unbound00000000001" }));
    const { listHandoffs } = store;
    assert.deepEqual(listHandoffs().map((entry) => entry.id), ["unbound00000000001"]);
  } finally { store.close?.(); }
});
