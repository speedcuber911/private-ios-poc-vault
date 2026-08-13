import { useEffect, useState } from "react";
import {
  CLI_CONFIRM_COPY,
  decideCliLogin,
  device as defaultDevice,
  parseUserCodeFromHash,
} from "../api/device.js";
import { Login, RelayMark } from "./Login";

type Phase =
  | "loading"
  | "login"
  | "web_code"
  | "cli_confirm"
  | "computer_linked"
  | "invalid"
  | "error";

function readHashCode() {
  return parseUserCodeFromHash(window.location.hash);
}

export function CliLogin({
  onApproved,
  onSignedUp,
}: {
  onApproved: () => void;
  onSignedUp: () => void;
}) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [machineName, setMachineName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [signedUp, setSignedUp] = useState(false);
  const [approving, setApproving] = useState(false);

  async function resolve(hasSession: boolean) {
    const userCode = readHashCode();
    if (!userCode) {
      setPhase("invalid");
      return;
    }
    if (!hasSession) {
      setPhase("login");
      return;
    }
    const inspect = await defaultDevice.inspectUserCode(userCode);
    const decision = decideCliLogin({ hasSession: true, inspect });
    if (decision.action === "login") {
      setPhase("login");
      return;
    }
    if (decision.action === "web_code") {
      setPhase("web_code");
      return;
    }
    if (decision.action === "computer_linked") {
      setPhase("computer_linked");
      return;
    }
    if (decision.action === "cli_confirm") {
      setMachineName(decision.machineName);
      setPhase("cli_confirm");
      return;
    }
    setPhase("invalid");
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!readHashCode()) {
        setPhase("invalid");
        return;
      }
      try {
        const session = await defaultDevice.getSession();
        if (cancelled) return;
        await resolve(session.ok);
      } catch {
        if (!cancelled) {
          setError("Can't reach the Relay control plane.");
          setPhase("error");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function approve() {
    const userCode = readHashCode();
    if (!userCode || approving) return;
    setApproving(true);
    setError(null);
    try {
      const result = await defaultDevice.approveUserCode(userCode);
      if (result.ok) {
        if (signedUp) onSignedUp();
        else onApproved();
        return;
      }
      if (result.status === 409) {
        setPhase("computer_linked");
        return;
      }
      setError("That code isn't valid anymore.");
    } catch {
      setError("Can't reach the Relay control plane.");
    } finally {
      setApproving(false);
    }
  }

  if (phase === "login") {
    return (
      <Login
        onSignedIn={() => {
          void resolve(true);
        }}
        onSignedUp={() => {
          setSignedUp(true);
          void resolve(true);
        }}
      />
    );
  }

  let body = (
    <>
      <h2>Checking this code</h2>
      <p>One moment.</p>
    </>
  );
  if (phase === "web_code") {
    body = (
      <>
        <h2>Approve this from the iPhone</h2>
        <p>This code signs a browser in. Open the Relay app and scan it there — this page will not approve it as a CLI login.</p>
      </>
    );
  } else if (phase === "cli_confirm") {
    body = (
      <>
        <h2>Approve this computer</h2>
        {machineName ? <p className="machine-name">{machineName}</p> : null}
        <p data-testid="relay-cli-confirm">{CLI_CONFIRM_COPY}</p>
        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="actions">
          <button
            type="button"
            className="btn-primary"
            disabled={approving}
            onClick={() => void approve()}
            data-testid="relay-cli-approve"
          >
            {approving ? "Approving…" : "Continue"}
          </button>
        </div>
      </>
    );
  } else if (phase === "computer_linked") {
    body = (
      <>
        <h2>A computer is already linked</h2>
        <p>Disconnect the linked computer on the phone, then run relay login again.</p>
      </>
    );
  } else if (phase === "invalid") {
    body = (
      <>
        <h2>That code isn&apos;t valid anymore.</h2>
        <p>Run relay login again on the computer you want to sign in.</p>
      </>
    );
  } else if (phase === "error") {
    body = (
      <>
        <h2>Can&apos;t reach Relay</h2>
        <p className="error" role="alert">
          {error}
        </p>
      </>
    );
  }

  return (
    <div className="auth">
      <div className="brand">
        <RelayMark />
        <div>
          <h1 className="wordmark">Relay</h1>
          <p className="tagline">Your agents, within reach.</p>
        </div>
      </div>
      <section className="cli-panel" aria-label="CLI login">
        {body}
      </section>
    </div>
  );
}
