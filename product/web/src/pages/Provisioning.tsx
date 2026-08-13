import { useEffect, useRef, useState } from "react";
import { RelayMark } from "./Login";
import { provisioningStage, trial as defaultTrial } from "../api/trial.js";

type Stage = "creating" | "booting" | "ready" | "failed";

const CAPACITY_COPY = "No trial machines are available.";

function trialErrorMessage(json: { error?: string } | null) {
  const error = json?.error;
  if (error === "trial_capacity" || error === "trial_unavailable") return CAPACITY_COPY;
  return "Relay could not complete that request.";
}

export function Provisioning({
  onReady,
  onNeedLogin,
}: {
  onReady: (nodeId: string | null) => void;
  onNeedLogin: () => void;
}) {
  const [stage, setStage] = useState<Stage>("creating");
  const [nodeId, setNodeId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const onNeedLoginRef = useRef(onNeedLogin);
  onNeedLoginRef.current = onNeedLogin;

  function applyTrial(trial: { state?: string; nodeId?: string | null } | null) {
    if (!trial) return;
    const mapped = provisioningStage(trial);
    setStage(mapped.stage as Stage);
    setNodeId(trial.nodeId ?? null);
    if (mapped.stage === "failed") setError(null);
  }

  async function begin(signal: AbortSignal, retry: boolean) {
    setWorking(true);
    setError(null);
    try {
      let current = retry ? null : await defaultTrial.getCurrent();
      if (signal.aborted) return;
      if (current?.status === 401) {
        onNeedLoginRef.current();
        return;
      }
      if (retry || !current?.ok) {
        current = await defaultTrial.startTrial();
        if (signal.aborted) return;
        if (current.status === 401) {
          onNeedLoginRef.current();
          return;
        }
        if (!current.ok) {
          setStage("failed");
          setError(trialErrorMessage(current.json));
          return;
        }
      }
      applyTrial(current.json?.trial);
      const state = current.json?.trial?.state;
      if (state === "ready" || state === "failed") return;
      const settled = await defaultTrial.pollUntilSettled({ interval: 2, signal });
      if (signal.aborted || settled.json?.error === "aborted") return;
      if (settled.status === 401) {
        onNeedLoginRef.current();
        return;
      }
      if (!settled.ok) {
        setStage("failed");
        setError(trialErrorMessage(settled.json));
        return;
      }
      applyTrial(settled.json?.trial);
    } catch {
      if (!signal.aborted) {
        setStage("failed");
        setError("Can't reach the Relay control plane.");
      }
    } finally {
      if (!signal.aborted) setWorking(false);
    }
  }

  useEffect(() => {
    const ac = new AbortController();
    void begin(ac.signal, false);
    return () => ac.abort();
  }, []);

  function retry() {
    const ac = new AbortController();
    void begin(ac.signal, true);
  }

  const live = stage !== "failed";
  const label =
    stage === "booting" ? "Booting" : stage === "ready" ? "Ready" : stage === "failed" ? "Failed" : "Creating";

  return (
    <div className="page">
      <div className="brand">
        <RelayMark />
        <div>
          <h1 className="page-title">Your machine</h1>
        </div>
      </div>
      <p className={live ? "status-word status-live" : "status-word status-error"}>{label}</p>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      {stage === "ready" ? (
        <div className="actions">
          <button type="button" className="btn-primary" onClick={() => onReady(nodeId)}>
            Open machine
          </button>
        </div>
      ) : null}
      {stage === "failed" ? (
        <div className="actions">
          <button type="button" className="btn-primary" disabled={working} onClick={() => retry()}>
            {working ? "Retrying…" : "Retry"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
