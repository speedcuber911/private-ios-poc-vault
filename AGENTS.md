# Relay Agent Contract

This repo now powers `Relay`: a private iPhone control surface for remote
Codex/Claude agent work and authenticated static POC viewing. The historical
POC Vault subsystem is still here, but do not treat it as the whole product.

There are two main surfaces:

- Hosted POCs: every POC lives under `pocs/<slug>/`, ships static files under
  `public/`, and is advertised through a signed manifest consumed by the iOS app.
- Remote agents: the phone talks to the EC2 Codex/Claude job API in
  `relay-server/` to start, monitor, continue, cancel, and review agent runs.

The remote job API lives inside this repo because the Relay iOS app, static POC
hosting, and EC2 runner are tightly coupled.

## Read This First

- Normal POC work is backend-driven. Do not edit `ios/POCVault/` for ordinary
  POC creation or deployment.
- Use this repository checkout as the source repo.
- Use `ops/deploy-poc` as the deployment interface.
- Never commit, print, or paste secrets from `~/.poc-vault/secrets`.
- Read `SECURITY.md` before pushing or adding new operational files.
- Be careful with the current worktree. POC deploys can legitimately modify
  ignored `ops/deploys.log` and create untracked `pocs/<slug>/` folders.
- For Relay server/API work, switch to
  `/Users/pariksj/Desktop/poc-vault/relay-server`.

## Non-Negotiable Provider Auth Guardrail

Relay uses the user's direct Codex, Claude, and Cursor subscriptions from the
isolated `codex-runner` home on `pariksj-dev`. Do not route Claude through
Bedrock or an AWS profile by default.

- Keep `CLAUDE_AWS_PROFILE`, `AWS_PROFILE`, `AWS_DEFAULT_PROFILE`, and
  `CLAUDE_CODE_USE_BEDROCK` unset for the live direct-subscription runner.
- Strip ambient AWS credentials and instance-role settings from Claude jobs.
- Do not request, enable, approve, or troubleshoot Anthropic/Claude Bedrock
  model access in the personal/Relay/POC Vault AWS account.
- Bedrock may be restored only after the user explicitly chooses it and
  confirms the exact AWS account/profile. The compatibility guard permits only
  `CLAUDE_AWS_PROFILE=sigiq`, but that profile is not part of the current live
  arrangement.
- Codex, Claude, and Cursor auth state must stay under the isolated runner home;
  do not copy it into a workspace or the repository.
- Azure OpenAI-compatible profiles use direct bearer-key files outside the repo.
  Keep them server-side with narrow permissions and never put key material in
  the public model catalog, iOS config, source, logs, or chat.

## Product Branding

- The user-facing iOS app name is `Relay`.
- Use `Relay` for app icons, logos, UI copy, App Store-style copy, marketing
  text, screenshots, onboarding, and any visual design direction.
- `POC Vault`, `POCVault`, `poc-vault`, and `com.parikshit.pocvault` are legacy
  or internal project, module, bundle, backend, and repo names. Do not infer the
  product brand from those names.
- Do not design around vault-door, keyhole, safe, lockbox, or storage metaphors
  unless the user explicitly asks for that direction.
- Keep existing internal names stable unless the user explicitly asks for a
  deeper rename. In particular, do not rename the bundle id, Swift module,
  Xcode target, manifest keys, repo path, or backend workspace just to make
  user-facing branding say `Relay`.

## Non-Negotiable Architecture Rule

POCs are backend-driven. Creating, updating, or deploying a POC must not require
changes under `ios/POCVault/`. Relay reads the signed manifest and opens the
published URL in an authenticated WebView; it does not know individual POCs at
compile time.

Touch `ios/POCVault/` only when the user explicitly asks to change Relay app
behavior, the manifest schema, enrollment/identity, signing/project settings, or
security behavior. If a POC request seems to need native code, first implement it
as static web assets or server-hosted behavior and call out the limitation.

## Deployment Configuration

- EC2 region: configured by `AWS_REGION`
- Instance name: configured by `INSTANCE_NAME`
- VM host/IP: configured by `DEPLOY_HOST`
- Vault domain: configured by `VAULT_DOMAIN`
- POC wildcard: configured by `POC_WILDCARD_DOMAIN`
- Server root: `/srv/poc-vault`
- Deploy user: `deploy`
- Local config: `~/.poc-vault/secrets/config.env`

Public DNS should send the vault host and wildcard POC host to the VM. nginx
enforces client-certificate auth for the manifest and POC pages. `/healthz` is
public and should return `200`.

Security wording matters: today the perimeter is "valid client certificate",
not "hardware-bound iPhone only." The Mac has the iPhone cert/key for operator
verification. Treat anything under `~/.poc-vault/secrets` as highly sensitive.

Codex API wording also matters: live `/v1/codex/*` should stay mTLS-only, with
the exact allowed subjects `CN=iphone` and `CN=parikshit-mac`.

## Scope Rules

- Do not touch another worker's area unless the user explicitly expands your ownership.
- POC slugs must be lowercase letters, numbers, and hyphens.
- The directory name and `poc.json` slug must match.
- A deployable POC must have `pocs/<slug>/public/index.html`.
- `pocs/<slug>/poc.json` is source metadata.
- Hashes, byte counts, URLs, and file lists are rendered into `build/manifest.json`; do not hand-edit those generated fields into metadata.
- Keep POCs static. If a POC needs a backend, document that separately before deployment.
- Do not edit iOS for ordinary POC work.

## POC Metadata

Required fields:

```json
{
  "slug": "example-poc",
  "title": "Example POC",
  "description": "Short sentence for the iOS library."
}
```

Recommended fields:

```json
{
  "createdAt": "2026-05-15T00:00:00Z",
  "updatedAt": "2026-05-15T00:00:00Z",
  "tags": ["demo", "internal"]
}
```

## Deploy Flow

Use `ops/deploy-poc` for normal staging and remote deploy:

```bash
ops/deploy-poc \
  --slug example-poc \
  --title "Example POC" \
  --description "Internal demo" \
  --source /path/to/static-build \
  --force
```

The deploy command validates the slug and `index.html`, stages a single HTML
file or a folder into `pocs/<slug>/public/`, renders `build/manifest.json`, signs
it when the Ed25519 key exists, appends a JSON line to local `ops/deploys.log`,
rsyncs to the EC2 staging path, then promotes to live.

Remote rsync happens when `DEPLOY_HOST` is present in
`~/.poc-vault/secrets/config.env` or the environment. Use `--local-only` only
for dry runs.

Live POC URL:

```text
https://<slug>.<configured-poc-domain>/
```

## Manifest And Signing

- Render locally with `python3 ops/render-manifest.py --pocs-dir pocs -o build/manifest.json`.
- Sign locally with `python3 ops/sign-manifest.py build/manifest.json`.
- The default signing key path is `~/.poc-vault/secrets/signing/manifest-ed25519.key`.
- Supported key formats: PEM/OpenSSH Ed25519 private key, raw 32-byte hex, or raw 32-byte base64/base64url.
- If the key is missing, `deploy-poc` continues in local mode and leaves the signature absent.
- The iOS app verifies `manifest.sig.json` using the embedded public key.

## iOS App Contract

The iOS app is `Relay`, not merely a vault shell. It is the mobile control
surface for agent runs and authenticated POC viewing.

- User-facing name and visual identity: `Relay`.
- Canonical physical-device bundle id: `com.parikshit.pocvault`.
- Do not use, reintroduce, install, or document sample/example bundle ids.
- The tests bundle id should follow the same prefix: `com.parikshit.pocvault.tests`.
- Library screen loads the configured production manifest URL.
- Simulator builds load `http://127.0.0.1:8787/manifest.json`.
- POC detail screens use a full-screen `WKWebView`.
- There should be no standard navigation bar above hosted POCs.
- The current back control is a small translucent floating button over the WebView.
- The back control dims during scroll and returns after scrolling settles.
- Each POC should remain self-contained as static web assets.

If the user asks for visual polish of a hosted POC, edit the POC's HTML/CSS/JS,
not Relay's native app code, unless the complaint is specifically about native
chrome or the app library.

## Agent Console Contract

Relay has an agent console that talks to:

```text
https://codex.pocs.conformal.live
```

The server implementation lives in this repo at:

```text
/Users/pariksj/Desktop/poc-vault/relay-server
```

The agent console may be edited here for iOS behavior such as prompt entry,
keyboard handling, provider/model/skill controls, job lists, thread browsing,
job detail logs, simplified result rendering, voice prompt capture,
cancel/retry behavior, and mTLS client wiring.

Do not add arbitrary-path execution from the iOS app. The server exposes only
registered workspace ids, currently `scratch`, `poc-vault`, and `sigiq`.

The phone agent screen should stay simple: header, a visible `Threads` entry,
conversation/results, and the composer. Do not reintroduce endpoint cards,
workspace cards, offline/online labels, or tick icons unless the user explicitly
asks for them.

The prompt editor must remain usable on iPhone: do not add a custom keyboard
accessory or floating dismiss control. Keep interactive scroll dismissal,
keyboard dismissal on `Send`/`Run`, and outside-tap dismissal on non-editor
content. Taps inside the composer must not resign focus.

## Mobile Parity Contract

Relay has native SwiftUI and Jetpack Compose apps. Shared provider/status rules,
wire models, request construction, SSE reduction, and compatibility behavior
belong in `mobile/relay-core`; platform UI and OS integrations stay native.

- For a shared mobile behavior change, update both native surfaces in the same
  change or record and explain the intentional difference in
  `mobile/parity-contract.json`.
- Add shared contract tests for UI-free behavior.
- Run `ops/verify-mobile` before handoff. It checks the parity ledger, shared
  tests, the Android APK build, and the iOS Simulator build.
- Keep `.github/workflows/mobile-parity.yml` required on `main` so one-sided
  shared-surface changes cannot merge silently.
- Do not describe the apps as fully feature-identical while an `android-gap`
  remains in the parity contract.

## Physical iPhone Provisioning

The app expects a `.p12` at:

```text
Documents/support/client.p12
```

inside the app data container. A non-secret support config can also be placed at:

```text
Documents/support/vault-config.json
```

with `manifestURL` and `signatureURL` values from local config. The passphrase lives in
`IPHONE_P12_PASSWORD` inside `~/.poc-vault/secrets/config.env`.

`vault-config.json` can also include:

```json
{
  "authBaseURL": "https://api.pocs.conformal.live",
  "codexBaseURL": "https://codex.pocs.conformal.live"
}
```

Opening Diagnostics creates the support directory if it is missing.

Provision the file when needed:

```bash
DEVICE=<device-id>
ops/provision-ios-support.sh --device "$DEVICE"
```

Then open Diagnostics in the app, enter the passphrase from the local config,
tap `Import Certificate`, and confirm `Keychain identity` is green.

Find connected devices with:

```bash
xcrun devicectl list devices
```

## Simulator Workflow

Use:

```bash
ios/launch-simulator.sh
```

This starts `ops/serve-simulator-poc-vault` on `127.0.0.1:8787` in a detached
`screen` session if needed, builds the simulator app, installs it, and launches
it. Simulator mode intentionally bypasses production mTLS and uses a locally
signed manifest.

Check the local simulator server:

```bash
curl -fsS http://127.0.0.1:8787/healthz
```

## Verification Before Handoff

Run these checks after changing deploy tooling, metadata, or app shell code:

```bash
python3 -m py_compile ops/render-manifest.py ops/sign-manifest.py ops/deploy-poc ops/serve-simulator-poc-vault
bash -n ios/launch-simulator.sh
python3 ops/render-manifest.py --pocs-dir pocs -o build/manifest.json
python3 ops/sign-manifest.py build/manifest.json --allow-missing-key
```

For live checks, prefer the repo verification script because it reads local
deployment values from `~/.poc-vault/secrets/config.env`:

```bash
ops/verify-server.sh
```

If DNS is stale locally, pass the VM IP without writing it into the repo:

```bash
ops/verify-server.sh --resolve-ip <vm-public-ip>
```

The manifest and POC page should be blocked without a cert and return `200`
with the configured client cert/key.

## Handoff Format

When you deploy or change the vault, tell the user:

- what changed
- the live POC URL, if relevant
- whether unauthenticated access is blocked
- whether manifest and POC return `200` with the client cert
- whether the iPhone app was rebuilt/installed or only backend files changed
- whether Codex API health/job checks passed, if Codex was touched
- any uncommitted or intentionally untouched files
