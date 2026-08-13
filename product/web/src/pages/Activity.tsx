import { useEffect, useState } from "react";
import { RelayMark } from "./Login";
import { activityCopy, grant as defaultGrant } from "../api/grant.js";

type Job = {
  id: string;
  status?: string;
  durationMs?: number;
  updatedAt?: string;
  lastEvent?: string;
  lastResult?: string;
};

type Thread = {
  id: string;
  lastJobStatus?: string;
  updatedAt?: string;
  lastEvent?: string;
  lastResult?: string;
};

function formatDuration(ms: number | undefined) {
  if (!Number.isFinite(ms) || (ms as number) < 0) return null;
  const totalSec = Math.floor((ms as number) / 1000);
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function statusWord(status: string | undefined) {
  if (!status) return null;
  if (status === "succeeded") return "DONE";
  return status.replace(/_/g, " ").toUpperCase();
}

function lastEvent(item: { lastEvent?: string; updatedAt?: string; lastResult?: string }) {
  return item.lastEvent || item.lastResult || item.updatedAt || null;
}

export function Activity({
  nodeId,
  onBack,
}: {
  nodeId: string;
  onBack: () => void;
}) {
  const [copy, setCopy] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [threads, setThreads] = useState<Thread[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await defaultGrant.loadActivity(nodeId);
        if (cancelled) return;
        if (!result.ok) {
          setCopy(activityCopy(result));
          return;
        }
        setJobs(result.jobs as Job[]);
        setThreads(result.threads as Thread[]);
        setCopy(activityCopy(result));
      } catch {
        if (!cancelled) setCopy("Can't reach this machine.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [nodeId]);

  return (
    <div className="page">
      <div className="brand">
        <RelayMark />
        <div>
          <h1 className="page-title">Activity</h1>
        </div>
      </div>
      <button type="button" className="btn-text back" onClick={onBack}>
        Machines
      </button>

      {copy ? (
        <p className={copy === "Can't reach this machine." ? "error" : "muted"} role={copy.startsWith("Can't") ? "alert" : undefined}>
          {copy}
        </p>
      ) : null}

      <ul className="machine-list">
        {jobs.map((job) => {
          const status = statusWord(job.status);
          const duration = formatDuration(job.durationMs);
          const live = job.status === "running";
          return (
            <li key={`job-${job.id}`} className="activity-row">
              <span className={live ? "status-word status-live" : job.status === "failed" ? "status-word status-error" : "status-word"}>
                {status}
                {duration ? (
                  <>
                    {" · "}
                    <span className="duration">{duration}</span>
                  </>
                ) : null}
              </span>
              {lastEvent(job) ? <span className="last-event">{lastEvent(job)}</span> : null}
            </li>
          );
        })}
        {threads.map((thread) => {
          const status = statusWord(thread.lastJobStatus);
          const live = thread.lastJobStatus === "running";
          return (
            <li key={`thread-${thread.id}`} className="activity-row">
              <span className={live ? "status-word status-live" : "status-word"}>{status || "THREAD"}</span>
              {lastEvent(thread) ? <span className="last-event">{lastEvent(thread)}</span> : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
