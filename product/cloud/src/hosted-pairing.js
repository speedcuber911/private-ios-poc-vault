// Hosted-only device reconnection. Account authorization remains a hosted
// control-plane trust boundary; ciphertext privacy is NOT a claim that a
// compromised hosted operator cannot impersonate an account or replace keys.
// Unlike initial trial provisioning, this path never transports a raw pairing
// secret. Only the addressed node can open its RLYSEAL1 envelope.
import { createHash } from "node:crypto";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_PENDING = 5;
const MAX_PER_HOUR = 20;
const HOUR = 3_600_000;
const MAX_TTL = 900_000;
const CAPABILITY_TTL = 300_000;

export function createHostedPairings({ db, registry, now = Date.now, accessAllowed }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS hosted_pairing_capabilities (
      node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
      seen_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS hosted_device_pairings (
      pairing_id TEXT PRIMARY KEY,
      node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      sealed_secret TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      ready_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS hosted_pairings_node ON hosted_device_pairings(node_id, created_at);
  `);

  function hostedNode(nodeId) {
    const node = registry.getNode(nodeId);
    const trial = node && registry.getTrialByNodeId(nodeId);
    return node && trial?.sandboxId && trial.accountId === node.accountId ? { node, trial } : null;
  }

  function noteCapability(nodeId) {
    const hosted = hostedNode(nodeId);
    if (!hosted || !accessAllowed(hosted.node)) return;
    db.prepare(`INSERT INTO hosted_pairing_capabilities(node_id, seen_at) VALUES (?, ?)
      ON CONFLICT(node_id) DO UPDATE SET seen_at = excluded.seen_at`).run(nodeId, now());
  }

  function pending(nodeId) {
    const hosted = hostedNode(nodeId);
    if (!hosted || !accessAllowed(hosted.node)) return [];
    return db.prepare(`SELECT p.pairing_id, p.sealed_secret, p.expires_at
      FROM hosted_device_pairings p JOIN pairing_sessions s ON s.id = p.pairing_id
      WHERE p.node_id = ? AND p.expires_at > ? AND s.closed_at IS NULL
      ORDER BY p.created_at LIMIT ?`).all(nodeId, now(), MAX_PENDING).map((p) => ({
        pairingId: p.pairing_id, sealedSecret: p.sealed_secret, expiresAt: p.expires_at,
      }));
  }

  function enqueue(accountId, nodeId, body) {
    const hosted = hostedNode(nodeId);
    if (!hosted || hosted.node.accountId !== accountId) return { status: 404, error: "not_found" };
    if (!["ready", "upgraded"].includes(hosted.trial.state) || !accessAllowed(hosted.node)) {
      return { status: 403, error: "hosted_access_unavailable" };
    }
    const { pairingId, sealedSecret } = body || {};
    if (Object.keys(body || {}).some((key) => !["pairingId", "sealedSecret"].includes(key)) ||
        typeof pairingId !== "string" || !UUID.test(pairingId) ||
        typeof sealedSecret !== "string" || sealedSecret.length > 4096) {
      return { status: 400, error: "invalid_device_pairing" };
    }
    const sealed = Buffer.from(sealedSecret, "base64");
    if (sealed.toString("base64") !== sealedSecret || sealed.length < 68 ||
        sealed.subarray(0, 8).toString() !== "RLYSEAL1") {
      return { status: 400, error: "invalid_device_pairing" };
    }
    const session = registry.getPairingSession(pairingId);
    if (!session || session.accountId !== accountId || session.kind !== "hosted-device" ||
        session.expiresAt <= now() || session.expiresAt > now() + MAX_TTL || session.closedAt !== null) {
      return { status: 409, error: "pairing_unavailable" };
    }
    const fingerprint = createHash("sha256").update(sealed).digest("hex");
    const existing = db.prepare("SELECT * FROM hosted_device_pairings WHERE pairing_id = ?").get(pairingId);
    if (existing) {
      return existing.node_id === nodeId && existing.fingerprint === fingerprint
        ? { status: 202, pairingId, expiresAt: existing.expires_at }
        : { status: 409, error: "pairing_conflict" };
    }
    const key = Buffer.from(hosted.node.encPubkey || "", "base64");
    const capability = db.prepare("SELECT seen_at FROM hosted_pairing_capabilities WHERE node_id = ?").get(nodeId);
    if (key.length !== 32 || key.toString("base64") !== hosted.node.encPubkey || !capability) {
      return { status: 409, error: "hosted_pairing_upgrade_required" };
    }
    if (capability.seen_at + CAPABILITY_TTL <= now()) return { status: 503, error: "hosted_pairing_unavailable" };
    // Synchronous transaction covers quota + insert across cloud processes.
    db.exec("BEGIN IMMEDIATE");
    try {
      const raced = db.prepare("SELECT * FROM hosted_device_pairings WHERE pairing_id=?").get(pairingId);
      if (raced) {
        db.exec("COMMIT");
        return raced.node_id === nodeId && raced.fingerprint === fingerprint
          ? { status: 202, pairingId, expiresAt: raced.expires_at }
          : { status: 409, error: "pairing_conflict" };
      }
      const count = db.prepare(`SELECT count(*) AS n FROM hosted_device_pairings
        WHERE account_id = ? AND created_at > ?`).get(accountId, now() - HOUR).n;
      if (count >= MAX_PER_HOUR || pending(nodeId).length >= MAX_PENDING) {
        db.exec("ROLLBACK");
        return { status: 429, error: "too_many_device_pairings" };
      }
      db.prepare(`INSERT INTO hosted_device_pairings
        (pairing_id,node_id,account_id,sealed_secret,fingerprint,expires_at,created_at)
        VALUES (?,?,?,?,?,?,?)`).run(pairingId, nodeId, accountId, sealedSecret, fingerprint, session.expiresAt, now());
      db.exec("COMMIT");
      return { status: 202, pairingId, expiresAt: session.expiresAt };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function sweep() {
    // Keep only a fingerprint after completion/expiry, for the one-hour rate
    // window. Account/node deletion cascades immediately; rendezvous expiry
    // clears ciphertext here without erasing the hourly rate-limit record.
    db.prepare(`UPDATE hosted_device_pairings SET sealed_secret = '' WHERE expires_at <= ? OR pairing_id IN
      (SELECT id FROM pairing_sessions WHERE closed_at IS NOT NULL)`).run(now());
    db.prepare("DELETE FROM hosted_device_pairings WHERE created_at <= ?").run(now() - HOUR);
  }
  function markReady(nodeId, pairingId) {
    const hosted = hostedNode(nodeId);
    if (!hosted || !accessAllowed(hosted.node)) return false;
    return db.prepare(`UPDATE hosted_device_pairings SET ready_at=coalesce(ready_at,?)
      WHERE pairing_id=? AND node_id=? AND expires_at>? AND pairing_id IN
      (SELECT id FROM pairing_sessions WHERE closed_at IS NULL AND node_blob IS NOT NULL)`)
      .run(now(), pairingId, nodeId, now()).changes === 1;
  }
  function isReady(pairingId) {
    const row = db.prepare("SELECT node_id,ready_at,expires_at FROM hosted_device_pairings WHERE pairing_id=?").get(pairingId);
    const hosted = row && hostedNode(row.node_id);
    return Boolean(hosted && accessAllowed(hosted.node) && row.ready_at !== null && row.expires_at > now());
  }
  return { enqueue, pending, noteCapability, sweep, markReady, isReady };
}
