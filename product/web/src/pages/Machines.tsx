import { useEffect, useRef, useState } from "react";
import { RelayMark } from "./Login";
import { confirmAndUnlink } from "../api/admin.js";
import {
  decideMachineAction,
  kindWord,
  machineStatusWord,
  trial as defaultTrial,
} from "../api/trial.js";

type NodeRow = {
  id: string;
  kind: string;
  name?: string | null;
  lastSeen?: number | null;
  createdAt?: number;
};

type Trial = {
  id?: string;
  state?: string;
  nodeId?: string | null;
  expiresAt?: number;
};

export function Machines({
  onOpen,
  onProvision,
  onNeedLogin,
}: {
  onOpen: (id: string) => void;
  onProvision: () => void;
  onNeedLogin: () => void;
}) {
  const [nodes, setNodes] = useState<NodeRow[]>([]);
  const [trial, setTrial] = useState<Trial | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [entitlements, setEntitlements] = useState<{ feature: string; value: string }[]>([]);
  const [waitlistJoined, setWaitlistJoined] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);
  const [unlinkingId, setUnlinkingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const onNeedLoginRef = useRef(onNeedLogin);
  onNeedLoginRef.current = onNeedLogin;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [account, listed, current] = await Promise.all([
          defaultTrial.getAccount(),
          defaultTrial.listNodes(),
          defaultTrial.getCurrent(),
        ]);
        if (cancelled) return;
        if (account.status === 401) {
          onNeedLoginRef.current();
          return;
        }
        if (!account.ok || !listed.ok) {
          setError("Can't reach the Relay control plane.");
          return;
        }
        setEmail(account.json?.account?.email ?? null);
        setEntitlements(account.json?.entitlements ?? []);
        setNodes(listed.json?.nodes ?? []);
        if (current.ok) setTrial(current.json?.trial ?? null);
      } catch {
        if (!cancelled) setError("Can't reach the Relay control plane.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const action = decideMachineAction({ nodes, entitlements, waitlistJoined });
  const now = Date.now();

  async function join() {
    if (!email || joining) return;
    setJoining(true);
    setError(null);
    try {
      const result = await defaultTrial.joinWaitlist(email);
      if (result.ok) setWaitlistJoined(true);
      else setError("Relay couldn't add you to the waitlist.");
    } catch {
      setError("Can't reach the Relay control plane.");
    } finally {
      setJoining(false);
    }
  }

  async function unlink(node: NodeRow) {
    if (unlinkingId) return;
    setUnlinkingId(node.id);
    setError(null);
    try {
      const result = await confirmAndUnlink(node.id, {
        unlink: (id) => defaultTrial.unlinkNode(id),
      });
      if ("cancelled" in result && result.cancelled) return;
      if (!result.ok) {
        setError("Relay couldn't unlink that machine.");
        return;
      }
      const [listed, current] = await Promise.all([
        defaultTrial.listNodes(),
        defaultTrial.getCurrent(),
      ]);
      if (!listed.ok) {
        setError("Can't reach the Relay control plane.");
        return;
      }
      setNodes(listed.json?.nodes ?? []);
      setTrial(current.ok ? current.json?.trial ?? null : null);
    } catch {
      setError("Can't reach the Relay control plane.");
    } finally {
      setUnlinkingId(null);
    }
  }

  return (
    <div className="page">
      <div className="brand">
        <RelayMark />
        <div>
          <h1 className="page-title">Machines</h1>
        </div>
      </div>

      {!loading && nodes.length === 0 ? <p className="muted">No machines yet</p> : null}

      <ul className="machine-list">
        {nodes.map((node) => {
          const status = machineStatusWord({
            node,
            trial: node.kind === "trial" ? trial : null,
            now,
          });
          const live = status.startsWith("TRIAL ·") || status === "READY";
          return (
            <li key={node.id} className="machine-item">
              <button type="button" className="machine-row" onClick={() => onOpen(node.id)}>
                <span className="machine-row-name">{node.name || "Machine"}</span>
                <span className="kind-word">{kindWord(node.kind)}</span>
                <span className={live ? "status-word status-live" : status === "FAILED" || status === "EXPIRED" ? "status-word status-error" : "status-word"}>
                  {status}
                </span>
              </button>
              <button
                type="button"
                className="btn-text"
                disabled={unlinkingId === node.id}
                onClick={() => void unlink(node)}
              >
                Unlink
              </button>
            </li>
          );
        })}
      </ul>

      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="actions">
        {!loading && action.action === "new_machine" ? (
          <button type="button" className="btn-primary" onClick={onProvision}>
            New machine
          </button>
        ) : null}
        {!loading && action.action === "waitlist" ? (
          <button type="button" className="btn-primary" disabled={joining || !email} onClick={() => void join()}>
            {joining ? "Joining…" : "Join the waitlist"}
          </button>
        ) : null}
        {!loading && action.action === "on_waitlist" ? <p className="status-word">On the waitlist.</p> : null}
      </div>
    </div>
  );
}
