import { useEffect, useRef, useState } from "react";
import { RelayMark } from "./Login";
import {
  isProvisioningTerminal,
  isRetryableProvisioning,
  provisioningStage,
  trial as defaultTrial,
} from "../api/trial.js";

type Stage = "creating" | "booting" | "ready" | "failed" | "expired" | "destroyed";

const STAGE_LABEL: Record<Stage, string> = {
  creating: "Creating",
  booting: "Booting",
  ready: "Ready",
  failed: "Failed",
  expired: "Expired",
  destroyed: "Destroyed",
};

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
  const abortRef = useRef<AbortController | null>(null);
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
      if (isProvisioningTerminal(current.json?.trial?.state)) return;
      const settled = await defaultTrial.pollUntilSettled({
        interval: 2,
        signal,
        onTrial: (trial) => {
          if (!signal.aborted) applyTrial(trial);
        },
      });
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
    abortRef.current = ac;
    void begin(ac.signal, false);
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  function retry() {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    void begin(ac.signal, true);
  }

  const live = stage === "creating" || stage === "booting" || stage === "ready";
  const label = STAGE_LABEL[stage];

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
      {isRetryableProvisioning(stage) ? (
        <div className="actions">
          <button type="button" className="btn-primary" disabled={working} onClick={() => retry()}>
            {working ? "Retrying…" : "Retry"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
