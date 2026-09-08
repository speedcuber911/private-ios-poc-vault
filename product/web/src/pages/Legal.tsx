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
      <p className="legal-updated">Effective September 8, 2026</p>
      <p>
        Relay is a private control surface for AI agent work. Relay does not supply or operate
        computers. You run the Relay node software on a machine you already control, and the
        iPhone app connects to it. This policy explains what Relay processes when you use the
        iPhone app, the web console, or the Relay node and CLI software.
      </p>

      <h2>Information Relay processes</h2>
      <ul>
        <li><strong>Account information:</strong> your name, email address, username, account ID, and authentication method.</li>
        <li><strong>Device information:</strong> app device identifiers, device name and platform, notification token, and signed-in session details.</li>
        <li><strong>Agent content:</strong> prompts, messages, run status, logs, outputs, attachments, workspace and repository metadata, and authenticated previews you choose to create or open.</li>
        <li><strong>Voice prompts:</strong> audio you intentionally record is sent for speech transcription. Relay keeps the resulting text and operational metadata, but does not retain the audio clip after the transcription request completes.</li>
        <li><strong>Service information:</strong> diagnostics, security events, machine registration records, and usage needed to operate, protect, and troubleshoot Relay.</li>
      </ul>

      <h2>Where agent work happens</h2>
      <p>
        Agent runs, files, and command output stay on the machine you connect. Relay's servers hold
        your account, your registered machines and devices, and the handoff and notification records
        needed to reach your phone. When you pair the app with your own machine by scanning the code
        that machine prints, the app connects to that machine directly and the pairing secret is not
        sent to Relay's servers.
      </p>

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
        transcription. When you choose an agent, Relay identifies its third-party AI provider before
        sending data: OpenAI for Codex, Anthropic for Claude, Cursor for Cursor Agent, Moonshot AI
        for Kimi, Microsoft for Azure OpenAI, or Amazon Web Services for Amazon Bedrock. Your selected
        provider processes agent content under the account, privacy terms, and controls configured on
        your Relay machine. Relay does not place provider credentials in its public catalog or app
        metadata.
      </p>
      <p>
        Before the app sends agent content to a selected AI provider for the first time, Relay shows
        a provider-specific disclosure and asks for your permission. The disclosure covers your prompt,
        conversation history, and any workspace files, attachments, or command output the agent needs
        to fulfill your request. If you decline, Relay does not send that request. Relay shares this
        content only to generate responses and perform the agent work you request; it does not include
        your Relay name, email, password, or device identifiers.
      </p>
      <p>
        Relay enables supported AI providers only when their published data-handling commitments and
        security controls provide protection equivalent to the safeguards described in this policy.
        Content remains subject to the selected provider's privacy terms and any retention or training
        controls on the provider account you configured on your machine.
      </p>

      <h2>Retention and deletion</h2>
      <p>
        Relay retains account and agent information while your account is active and as needed for
        security, support, and legal obligations. You can delete your account in Relay under
        Settings → Security → Delete account. Deletion removes your Relay account, registered
        devices, node records, and entitlements. Relay does not operate the machines you connect,
        so the files on them remain under your control and must be deleted by you.
      </p>

      <h2>Security, transfers, and children</h2>
      <p>
        Relay uses encrypted transport, restricted machine registration, and access controls, but
        no online service can guarantee absolute security. You are responsible for the security of
        the machine you run Relay on. Providers may process information in countries other than your
        own. Relay is not directed to children under 13.
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
      <p className="legal-updated">Effective September 8, 2026</p>
      <p>
        These terms supplement Apple's Standard Licensed Application End User License Agreement
        and apply to the Relay app, the web console, and the Relay node and CLI software you run
        on your own machine. By using Relay, you agree to these terms.
      </p>

      <h2>Your account and your machine</h2>
      <p>
        You must provide accurate account information, protect your credentials, and be legally
        able to use Relay. Relay does not provide computing capacity. You supply the machine,
        install the Relay node software on it, and pair it with the app. You are responsible for
        that machine, its network exposure, its backups, and everything that runs on it. Relay does
        not include third-party AI-provider subscriptions or their usage charges.
      </p>

      <h2>Payments</h2>
      <p>
        Relay does not currently sell subscriptions or other in-app purchases. Any charges for the
        machine you run and for the AI providers you connect are between you and those providers.
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
        <li>distribute malware, evade security controls, or interfere with the service; or</li>
        <li>harass, exploit, or endanger another person.</li>
      </ul>

      <h2>Your content</h2>
      <p>
        You retain your rights in prompts, files, and outputs. You grant Relay the limited permission
        needed to transmit, store, and process that content to provide the service. You confirm that
        you have the rights and permissions needed for the content and services you connect.
      </p>

      <h2>Availability and responsibility</h2>
      <p>
        Relay is beta software and may change, be suspended, or be discontinued. To the extent allowed
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
        Relay lets you start, monitor, continue, and review AI agent work on a machine you run
        yourself. For help, email <a href={`mailto:${supportEmail}`}>{supportEmail}</a>.
      </p>

      <h2>Before contacting support</h2>
      <ul>
        <li>Confirm the phone has an internet connection and can reach the machine you paired.</li>
        <li>Confirm the Relay node software is running on that machine.</li>
        <li>Open Settings and confirm the expected machine is listed as paired.</li>
        <li>If pairing fails, print a fresh pairing code on the machine and scan that one; codes are single-use.</li>
        <li>If a run is still active, open Threads and refresh before starting a duplicate run.</li>
        <li>Provider sign-in and billing are managed by the provider you configured on your machine.</li>
      </ul>

      <h2>Account deletion</h2>
      <p>
        In the iPhone app, open Settings → Security → Delete account. Password accounts must confirm
        their current password. This permanently removes the Relay account and its records. The
        machine you run and the files on it are yours and are not touched.
      </p>

      <h2>What to include</h2>
      <p>
        Include the Relay app version, the approximate time of the problem, and what you expected to
        happen. Do not email passwords, private keys, pairing codes, provider tokens, or sensitive
        source files.
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
