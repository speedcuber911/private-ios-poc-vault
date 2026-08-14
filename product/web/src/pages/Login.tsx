import { useEffect, useRef, useState, type FormEvent } from "react";
import { cloud } from "../api/cloud.js";
import { device as defaultDevice, qrPayloadFromStart, iphonePollErrorMessage } from "../api/device.js";
import { drawQrToCanvas } from "../api/qr.js";

type Mode = "signIn" | "createAccount";
type Panel = "credentials" | "iphone";

const AUTH_ERRORS: Record<string, string> = {
  INVALID_USERNAME_OR_PASSWORD: "The username or password is incorrect.",
  INVALID_EMAIL_OR_PASSWORD: "The username or password is incorrect.",
  USERNAME_IS_ALREADY_TAKEN: "That username is already taken.",
  USER_ALREADY_EXISTS: "An account already exists for that email.",
  PASSWORD_TOO_SHORT: "Use a password with at least 8 characters.",
};

function authErrorMessage(json: { code?: string; message?: string; error?: string } | null) {
  const code = json?.code ?? json?.error;
  if (code && AUTH_ERRORS[code]) return AUTH_ERRORS[code];
  return json?.message ?? json?.error ?? "Relay could not complete that request.";
}

function credentialsAreValid(mode: Mode, username: string, email: string, password: string) {
  const validUsername = username.trim().length >= 3;
  const validPassword = password.length >= 8;
  if (mode === "createAccount") {
    return validUsername && validPassword && email.includes("@");
  }
  return validUsername && validPassword;
}

export function RelayMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 34 34" aria-hidden="true">
      <defs>
        <linearGradient id="ember-mark" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#E8965C" />
          <stop offset="1" stopColor="#C96F35" />
        </linearGradient>
      </defs>
      <path
        d="M17 5.5 L29.5 27.5 H4.5 Z"
        fill="none"
        stroke="url(#ember-mark)"
        strokeWidth="1.6"
        strokeLinejoin="round"
        strokeDasharray="1.2 2.4"
      />
      <circle cx="17" cy="5.5" r="2.15" fill="url(#ember-mark)" />
      <circle cx="29.5" cy="27.5" r="2.15" fill="url(#ember-mark)" />
      <circle cx="4.5" cy="27.5" r="2.15" fill="url(#ember-mark)" />
    </svg>
  );
}

function UnderlineField({
  id,
  label,
  type = "text",
  autoComplete,
  value,
  onChange,
}: {
  id: string;
  label: string;
  type?: string;
  autoComplete: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="underline-field" htmlFor={id}>
      <input
        id={id}
        name={id}
        type={type}
        value={value}
        placeholder={label}
        autoComplete={autoComplete}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
        data-testid={`relay-${id}`}
      />
      <span className="underline" />
    </label>
  );
}

function QrMark({ payload }: { payload: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!ref.current || !payload) return;
    drawQrToCanvas(ref.current, payload, { modulePx: 5 });
  }, [payload]);
  return <canvas ref={ref} className="qr-canvas" role="img" aria-label="Sign-in QR code" />;
}

function IphonePanel({
  onBack,
  onSignedIn,
}: {
  onBack: () => void;
  onSignedIn: () => void;
}) {
  const deviceApi = defaultDevice;
  const [userCode, setUserCode] = useState<string | null>(null);
  const [payload, setPayload] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const onSignedInRef = useRef(onSignedIn);
  onSignedInRef.current = onSignedIn;

  useEffect(() => {
    const ac = new AbortController();
    (async () => {
      try {
        const started = await deviceApi.startWebLogin();
        if (ac.signal.aborted) return;
        if (!started.ok) {
          setError("Relay could not start phone sign-in.");
          return;
        }
        setUserCode(started.json?.userCode ?? null);
        setPayload(qrPayloadFromStart(started.json));
        const granted = await deviceApi.pollWebLogin(started.json.deviceCode, {
          interval: started.json.interval,
          expiresIn: started.json.expiresIn,
          signal: ac.signal,
        });
        if (ac.signal.aborted) return;
        if (granted.status === 200) {
          onSignedInRef.current();
          return;
        }
        if (granted.json?.error === "aborted") return;
        setError(iphonePollErrorMessage(granted.json?.error));
      } catch {
        if (!ac.signal.aborted) setError("Can't reach the Relay control plane.");
      }
    })();
    return () => ac.abort();
  }, [deviceApi]);

  return (
    <div className="auth">
      <div className="brand">
        <RelayMark />
        <div>
          <h1 className="wordmark">Relay</h1>
          <p className="tagline">Your agents, within reach.</p>
        </div>
      </div>
      <section className="iphone-panel" aria-label="Sign in with iPhone">
        <h2>Sign in with iPhone</h2>
        <p>Scan this code on the signed-in Relay app.</p>
        <div className="qr-slot" aria-hidden={!payload}>
          {payload ? <QrMark payload={payload} /> : null}
        </div>
        <p className="user-code" data-testid="relay-user-code">
          {userCode || "———— ————"}
        </p>
        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : null}
      </section>
      <div className="actions">
        <button type="button" className="btn-text" onClick={onBack}>
          Use username instead
        </button>
      </div>
    </div>
  );
}

export function Login({
  onSignedIn,
  onSignedUp,
}: {
  onSignedIn: () => void;
  onSignedUp: () => void;
}) {
  const [mode, setMode] = useState<Mode>("signIn");
  const [panel, setPanel] = useState<Panel>("credentials");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const valid = credentialsAreValid(mode, username, email, password);
  const submitLabel = mode === "signIn" ? "Sign in" : "Create account";

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!valid || working) return;
    setWorking(true);
    setError(null);
    try {
      const result =
        mode === "signIn"
          ? await cloud.signIn({ username, password })
          : await cloud.signUp({ email, username, password });
      if (!result.ok) {
        setError(authErrorMessage(result.json));
        return;
      }
      if (mode === "signIn") onSignedIn();
      else onSignedUp();
    } catch {
      setError("Can't reach the Relay control plane.");
    } finally {
      setWorking(false);
    }
  }

  function switchMode() {
    setMode(mode === "signIn" ? "createAccount" : "signIn");
    setError(null);
    setPassword("");
  }

  if (panel === "iphone") {
    return (
      <IphonePanel onBack={() => setPanel("credentials")} onSignedIn={onSignedIn} />
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

      <form onSubmit={submit} noValidate>
        <div className="fields">
          <UnderlineField
            id="username"
            label="Username"
            autoComplete="username"
            value={username}
            onChange={setUsername}
          />
          {mode === "createAccount" ? (
            <UnderlineField
              id="email"
              label="Email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={setEmail}
            />
          ) : null}
          <UnderlineField
            id="password"
            label="Password"
            type="password"
            autoComplete={mode === "signIn" ? "current-password" : "new-password"}
            value={password}
            onChange={setPassword}
          />
        </div>

        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : null}

        <div className="actions">
          <button
            type="submit"
            className="btn-primary"
            disabled={!valid || working}
            data-testid="relay-credential-submit"
          >
            {working ? (mode === "signIn" ? "Signing in…" : "Creating…") : submitLabel}
          </button>
          <button type="button" className="btn-text" onClick={() => setPanel("iphone")}>
            Sign in with iPhone
          </button>
        </div>
      </form>

      <div className="mode-switch">
        <span>{mode === "signIn" ? "New here?" : "Already have an account?"}</span>
        <button type="button" onClick={switchMode}>
          {mode === "signIn" ? "Create an account" : "Sign in"}
        </button>
      </div>
    </div>
  );
}
