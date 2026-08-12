// relayd index.mjs — entry point, extracted from relay-server/codex-api-deploy/server.mjs (W2-CORE, behavior-preserving).
import fs from "node:fs";
import http from "node:http";

// Evaluation-order guards: config first (env validation throws at startup),
// then catalog (CODEX_MODEL_CATALOG validation), then workspaces (CODEX_WORKSPACES).
import "./config.mjs";
import "./catalog.mjs";
import "./workspaces.mjs";

import {
  host,
  port,
  listenMode,
  listensDirect,
  listensTunneled,
  pairingEnabled,
  pairingHost,
  pairingPort,
  recordPairingListener,
  tunnelHost,
  tunnelPort,
  tunnelSuffix,
  tunnelSni,
  tunnelHeartbeatMs,
  tunnelBackoffBaseMs,
  tunnelBackoffMaxMs,
  cloudUrl,
  handoffEnabled,
  handoffPollWaitSec,
  dataDir,
  runHome,
  codexHome,
} from "./config.mjs";
import { loadPersistedJobs, processQueue } from "./jobs.mjs";
import { routeRequest } from "./server.mjs";
import { sendError } from "./util.mjs";
import { appendAudit } from "./audit.mjs";
import { identityPaths, readNodeId, getCaPem, ensureServerCert, isRevokedSerial } from "./identity.mjs";
import { startTunnelService } from "./tunnel.mjs";
import { startPairingListener, prunePairingSessions } from "./pairing.mjs";

loadPersistedJobs();
processQueue();

function handleRequest(req, res) {
  routeRequest(req, res).catch((error) => {
    const status = Number.isInteger(error.status) ? error.status : 500;
    sendError(res, status, error.message || "internal error");
  });
}

// --- direct listen mode (default; unchanged behavior) ----------------------

const server = listensDirect ? http.createServer(handleRequest) : null;

if (server) {
  // A bind failure on the DATA listener is fatal — but it must be a clean,
  // actionable exit, not an unhandled 'error' event. Without this handler an
  // EADDRINUSE surfaced as a raw stack trace, and under systemd's
  // Restart=on-failure that became a silent crash loop.
  server.on("error", (error) => {
    if (error && error.code === "EADDRINUSE") {
      console.error(
        `relayd: cannot bind the data listener on ${host}:${port} — address already in use. ` +
          "Another process (often a second relayd) already owns it; free the port or set CODEX_API_PORT.",
      );
    } else {
      console.error(`relayd: data listener failed on ${host}:${port} — ${error?.message || String(error)}`);
    }
    appendAudit("data_listener_failed", null, { host, port, error: error?.code || error?.message || String(error) });
    process.exit(1);
  });
  server.listen(port, host, () => {
    console.log(`codex-api listening on http://${host}:${port}`);
  });
}

// --- pairing listener ------------------------------------------------------
//
// The DAEMON owns it. `relayd pair` mints a session into the shared store and
// exits; without a listener in the long-running process the printed code could
// never be redeemed on a systemd install (that was the onboarding dead end).
//
// It is always a SEPARATE listener from the data listener — POST /v1/pair is
// authenticated by the single-use pairing secret and a blob MAC, never by a
// client certificate, so it must never share the mTLS data port. config.mjs
// refuses a configuration where the two would collide.
//
// A bind failure is loud but NOT fatal: losing pairing must not take an
// otherwise healthy node (and its running jobs) offline.
//
// RELAYD_PAIRING_PORT unset means port 0 — the kernel picks a free port and we
// print/persist it. relayd must never claim a port the operator did not give
// it (the old CODEX_API_PORT + 1 default killed co-located daemons).

let pairingServer = null;

function startPairing() {
  if (!pairingEnabled) {
    console.log("relayd: pairing listener disabled (RELAYD_PAIRING_ENABLED=false); `relayd pair` codes cannot be redeemed");
    return;
  }
  if (listensDirect && pairingPort !== 0 && pairingPort === port && pairingHost === host) {
    // Defence in depth: config.mjs already refuses this.
    throw new Error("pairing listener would collide with the mTLS data listener");
  }
  prunePairingSessions();
  startPairingListener({ host: pairingHost, port: pairingPort })
    .then((server) => {
      pairingServer = server;
      const address = server.address();
      const boundPort = address && typeof address === "object" ? address.port : pairingPort;
      // `relayd pair` runs in a different process and cannot see an ephemeral
      // port otherwise, so the bound address is persisted for it to read back.
      recordPairingListener({ host: pairingHost, port: boundPort });
      console.log(`relayd pairing listener on http://${pairingHost}:${boundPort}/v1/pair`);
      appendAudit("pairing_listener_started", null, { host: pairingHost, port: boundPort });
    })
    .catch((error) => {
      console.error(
        `relayd: pairing listener failed to bind ${pairingHost}:${pairingPort} — ${error.message}; ` +
          "`relayd pair` codes cannot be redeemed until this is fixed (set RELAYD_PAIRING_PORT)",
      );
      appendAudit("pairing_listener_failed", null, {
        host: pairingHost,
        port: pairingPort,
        error: error.message || String(error),
      });
    });
}

startPairing();

// --- handoff + credential-sync pickup loop ----------------------------------
//
// Long-polls the control plane for pending `relay handoff` pickups and, when
// one lands, imports it (clone, decrypt, stage for --resume, register a
// workspace). The same poll also carries credential-sync notices: `relay
// sync-auth` seals the operator's GitHub token and harness logins to this
// node's X25519 key, drops them in a rendezvous slot and announces it, and
// installFromNotice collects, verifies the MAC, unseals and installs them.
// One held connection carries both.
//
// Optional and best-effort: unlike the data/pairing listeners, this node is
// fully usable without it, so a missing node identity or a cloud client that
// fails to construct is logged rather than fatal — it must not take an
// otherwise healthy node (and its running jobs) offline. It does mean
// RELAYD_HANDOFF_ENABLED=false switches off credential sync too, which the
// message below says out loud rather than leaving the operator to discover.
async function startHandoffPickup() {
  if (!handoffEnabled || !cloudUrl) {
    console.log(
      "relayd: handoff + credential-sync loop disabled (RELAYD_HANDOFF_ENABLED=false or no RELAYD_CLOUD_URL); " +
        "`relay sync-auth` credentials will never be collected while it is off",
    );
    return;
  }
  try {
    const { createCloudClient } = await import("./cloudclient.mjs");
    const { startHandoffLoop, completeHandoffJob } = await import("./handoff.mjs");
    const { setHandoffCompletionHook } = await import("./jobs.mjs");
    const { installFromNotice } = await import("./syncauth.mjs");
    setHandoffCompletionHook(completeHandoffJob);
    // `cloud` is referenced inside the handler, which only ever runs after
    // createCloudClient has returned and this binding is initialized.
    const cloud = createCloudClient({
      cloudUrl,
      onNotice: (notice) =>
        installFromNotice(notice, {
          cloudUrl,
          runHome,
          codexHome,
          dataDir,
          // So a failed sync also reaches the user's phone, not just this
          // node's audit log and event feed.
          postEvent: (type) => cloud.postEvent(type),
        }),
    });
    startHandoffLoop({ cloud, waitSec: handoffPollWaitSec });
    console.log(`relayd: handoff + credential-sync loop started against ${cloudUrl}`);
  } catch (error) {
    console.error(`relayd: handoff loop failed to start — ${error?.message || String(error)}`);
    appendAudit("handoff_loop_start_failed", null, { error: error?.message || String(error) });
  }
}

startHandoffPickup();

// --- tunneled listen mode --------------------------------------------------

// Assembles the tunnel client from the node identity (identity.mjs owns the
// keys, the node CA and the revocation list) and dials the broker. Throws a
// plain, actionable error when anything required is missing — a node that
// cannot serve its only listener must not come up half-started.
function startTunnel() {
  if (!tunnelHost) {
    throw new Error(`RELAYD_LISTEN_MODE=${listenMode} requires RELAYD_TUNNEL_HOST (the broker endpoint)`);
  }

  const paths = identityPaths();
  const nodeId = readNodeId(paths);
  if (!nodeId || !fs.existsSync(paths.identityKeyPath)) {
    throw new Error(`node identity is not initialized in ${paths.baseDir}; run \`relayd pair\` once to create it`);
  }
  if (!fs.existsSync(paths.caCertPath)) {
    throw new Error(`node CA is missing from ${paths.caDir}; run \`relayd pair\` once to create it`);
  }

  // The broker routes on SNI, so the server cert must carry the public name
  // as a SAN. ensureServerCert is idempotent per SAN.
  const san = tunnelSni || `${nodeId}${tunnelSuffix}`;
  const serverCert = ensureServerCert({ san });

  const service = startTunnelService({
    brokerHost: tunnelHost,
    brokerPort: tunnelPort,
    nodeId,
    identityKeyPem: fs.readFileSync(paths.identityKeyPath, "utf8"),
    tlsCertPem: fs.readFileSync(serverCert.certPath, "utf8"),
    tlsKeyPem: fs.readFileSync(serverCert.keyPath, "utf8"),
    deviceCaPem: getCaPem(),
    // routeRequest is safe to pass directly: startTunnelClient wraps every
    // handler so inbound x-ssl-client-* headers are stripped and re-derived
    // from the TLS peer certificate.
    handler: handleRequest,
    isRevokedSerial,
    heartbeatMs: tunnelHeartbeatMs,
    backoffBaseMs: tunnelBackoffBaseMs,
    backoffMaxMs: tunnelBackoffMaxMs,
    onState: (state, detail) => {
      const suffix = detail.attempt ? ` attempt=${detail.attempt}` : "";
      const delay = detail.delayMs ? ` retryInMs=${detail.delayMs}` : "";
      const reason = detail.error ? ` reason=${detail.error}` : "";
      console.log(`relayd tunnel ${state}: broker=${tunnelHost}:${tunnelPort} sni=${san}${suffix}${delay}${reason}`);
      appendAudit(`tunnel_${state}`, null, {
        nodeId,
        broker: `${tunnelHost}:${tunnelPort}`,
        sni: san,
        ...detail,
      });
    },
  });

  console.log(`codex-api listening through broker ${tunnelHost}:${tunnelPort} as ${san}`);
  return service;
}

let tunnel = null;
if (listensTunneled) {
  try {
    tunnel = startTunnel();
  } catch (error) {
    console.error(`relayd: tunneled listen mode cannot start — ${error.message}`);
    process.exit(1);
  }
}

// Clean shutdown. Only installed when a tunnel is running: in plain direct
// mode the historical default signal disposition is preserved exactly.
if (tunnel) {
  const shutdown = (signal) => {
    console.log(`relayd: ${signal} received, shutting down`);
    tunnel.stop();
    if (server) {
      server.close();
      server.closeAllConnections?.();
    }
    if (pairingServer) {
      pairingServer.close();
      pairingServer.closeAllConnections?.();
    }
    // Give the audit append and socket teardown a tick, then leave.
    setTimeout(() => process.exit(0), 50).unref();
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}
