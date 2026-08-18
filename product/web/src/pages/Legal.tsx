type LegalPageProps = {
  page: "privacy" | "terms" | "support";
  onNavigate: (path: string) => void;
};

const supportEmail = "parikshit.joon@gmail.com";

function LegalNav({ onNavigate }: Pick<LegalPageProps, "onNavigate">) {
  return (
    <nav className="legal-nav" aria-label="Legal and support">
      <button type="button" onClick={() => onNavigate("/privacy")}>Privacy</button>
      <button type="button" onClick={() => onNavigate("/terms")}>Terms</button>
      <button type="button" onClick={() => onNavigate("/support")}>Support</button>
    </nav>
  );
}

function Privacy() {
  return (
    <>
      <h1>Privacy Policy</h1>
      <p className="legal-updated">Effective August 18, 2026</p>
      <p>
        Relay is a private control surface for AI agent work. This policy explains what Relay
        processes when you use the iPhone app, web console, hosted sandbox, or a Relay runner.
      </p>

      <h2>Information Relay processes</h2>
      <ul>
        <li><strong>Account information:</strong> your name, email address, username, account ID, and authentication method.</li>
        <li><strong>Device information:</strong> app device identifiers, device name and platform, notification token, and signed-in session details.</li>
        <li><strong>Agent content:</strong> prompts, messages, run status, logs, outputs, attachments, workspace and repository metadata, and authenticated previews you choose to create or open.</li>
        <li><strong>Voice prompts:</strong> audio you intentionally record is sent for speech transcription. Relay keeps the resulting text and operational metadata, but does not retain the audio clip after the transcription request completes.</li>
        <li><strong>Service information:</strong> diagnostics, security events, machine state, and usage needed to operate, protect, and troubleshoot Relay.</li>
      </ul>

      <h2>How information is used</h2>
      <p>
        Relay uses this information to authenticate you, connect registered machines, run and
        display agent work, deliver notifications, provide support, prevent abuse, and maintain
        the service. Relay does not sell personal information, serve behavioral advertising, or
        track you across other companies' apps and websites.
      </p>

      <h2>Service providers and agent providers</h2>
      <p>
        Relay uses infrastructure and authentication providers to operate the service, Apple for
        Sign in with Apple and notifications, and Microsoft Azure Speech when you request voice
        transcription. Prompts and files are also processed by the AI provider you select—such as
        Codex, Claude Code, Cursor, or Kimi—under the account and terms configured on your Relay
        machine. Relay does not place provider credentials in its public catalog or app metadata.
      </p>

      <h2>Retention and deletion</h2>
      <p>
        Relay retains account and agent information while your account is active and as needed for
        security, support, and legal obligations. You can delete your account in Relay under
        Settings → Security → Delete account. Deletion removes your Relay account, registered
        devices, node records, entitlements, and hosted Relay sandbox data. Files on machines you
        own remain under your control and must be deleted by you.
      </p>

      <h2>Security, transfers, and children</h2>
      <p>
        Relay uses encrypted transport, restricted machine registration, and access controls, but
        no online service can guarantee absolute security. Providers may process information in
        countries other than your own. Relay is not directed to children under 13.
      </p>

      <h2>Changes and contact</h2>
      <p>
        Material changes will be reflected here with a new effective date. For privacy questions
        or requests, email <a href={`mailto:${supportEmail}`}>{supportEmail}</a>.
      </p>
    </>
  );
}

function Terms() {
  return (
    <>
      <h1>Terms of Use</h1>
      <p className="legal-updated">Effective August 18, 2026</p>
      <p>
        These terms supplement Apple's Standard Licensed Application End User License Agreement
        and apply to the Relay app, web console, hosted sandbox, and runner software. By using
        Relay, you agree to these terms.
      </p>

      <h2>Your account and services</h2>
      <p>
        You must provide accurate account information, protect your credentials, and be legally
        able to use Relay. Relay may provide a hosted sandbox or let you connect a machine you
        control. Access to a hosted sandbox may be time-limited or separately granted. This version
        of Relay does not sell an in-app subscription or include third-party AI subscriptions.
      </p>

      <h2>AI providers and agent actions</h2>
      <p>
        You are responsible for the AI-provider accounts you connect, their charges and terms, the
        workspaces you register, and every instruction you send. Agent output can be incomplete or
        incorrect, and agent actions can modify files or external systems. Review important work,
        keep backups, and use approval controls appropriate to the risk.
      </p>

      <h2>Acceptable use</h2>
      <p>You may not use Relay to:</p>
      <ul>
        <li>break the law, infringe rights, or access systems or data without authorization;</li>
        <li>distribute malware, evade security controls, or interfere with the service;</li>
        <li>harass, exploit, or endanger another person; or</li>
        <li>resell or share hosted access unless Relay has approved it.</li>
      </ul>

      <h2>Your content</h2>
      <p>
        You retain your rights in prompts, files, and outputs. You grant Relay the limited permission
        needed to transmit, store, and process that content to provide the service. You confirm that
        you have the rights and permissions needed for the content and services you connect.
      </p>

      <h2>Availability and responsibility</h2>
      <p>
        Relay may change, suspend, or discontinue beta or hosted functionality. To the extent allowed
        by law, Relay is provided “as is” without warranties, and the operator is not liable for
        indirect or consequential loss. Nothing here limits rights that cannot legally be limited.
      </p>

      <h2>Termination and contact</h2>
      <p>
        You may stop using Relay and delete your account at any time. Relay may suspend access for
        security, abuse, or a material breach of these terms. Questions can be sent to
        {" "}<a href={`mailto:${supportEmail}`}>{supportEmail}</a>.
      </p>
    </>
  );
}

function Support() {
  return (
    <>
      <h1>Relay Support</h1>
      <p>
        Relay lets you start, monitor, continue, and review AI agent work on a registered Relay
        machine. For help, email <a href={`mailto:${supportEmail}`}>{supportEmail}</a>.
      </p>

      <h2>Before contacting support</h2>
      <ul>
        <li>Confirm the phone has an internet connection and that you are signed into the expected Relay account.</li>
        <li>Open Settings and confirm the expected computer or hosted sandbox appears under Signed in.</li>
        <li>If a run is still active, open Threads and refresh before starting a duplicate run.</li>
        <li>Provider sign-in and billing are managed by the provider configured on your Relay machine.</li>
      </ul>

      <h2>Account deletion</h2>
      <p>
        In the iPhone app, open Settings → Security → Delete account. Password accounts must confirm
        their current password. This permanently removes the Relay account and hosted Relay data;
        files on machines you own remain your responsibility.
      </p>

      <h2>What to include</h2>
      <p>
        Include the Relay app version, the approximate time of the problem, and what you expected to
        happen. Do not email passwords, private keys, provider tokens, or sensitive source files.
      </p>
    </>
  );
}

export function LegalPage({ page, onNavigate }: LegalPageProps) {
  return (
    <article className="legal-page">
      <a className="legal-brand" href="/login">Relay</a>
      {page === "privacy" ? <Privacy /> : page === "terms" ? <Terms /> : <Support />}
      <LegalNav onNavigate={onNavigate} />
    </article>
  );
}
