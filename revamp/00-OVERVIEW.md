# Relay Revamp — EC2 Files Browser + Per-Folder Agent Chat

> Updated 2026-08-11 for the current `pariksj-dev` deployment. The files-first
> navigation, folder conversations, visible Threads history, and revised
> keyboard behavior are implemented. Server detail
> lives in [01-server-plan.md](01-server-plan.md) and
> [02-ios-plan.md](02-ios-plan.md).

## Why

Relay originally exposed Library, Chat, Task, and Status as separate areas. The
implemented mental model is simpler: **Relay is the private iPhone interface to
the isolated agent workspace on `pariksj-dev`.** Browse the workspace jail like
the iPhone Files app and, from any folder, open a conversation scoped to that
folder.

## Current baseline (do not redesign around older infrastructure)

- Live gateway: `https://relay.65-2-161-233.sslip.io` on `pariksj-dev`.
- Public DNS/TLS uses `sslip.io` plus Caddy. Relay does **not** use Tailscale.
- `/healthz` is public. Every `/v1/codex/*` route is mTLS-only.
- Only `CN=iphone` and `CN=parikshit-mac` are allowed. Caddy validates the
  client certificate and the backend re-checks the forwarded exact subject.
- The static POC side is live on the same host. Caddy mounts `/srv/poc-vault`
  read-only, serves the signed five-item manifest at `/manifest.json`, and
  serves POCs at `/pocs/<slug>/`. Wildcard POC hosting is disabled for this
  arrangement.
- Manifest and POC routes return 403 without a client certificate and 200 with
  either the Mac or iPhone identity. The iPhone support config contains the
  matching manifest public key.
- A dedicated deploy user/key and `/srv/poc-vault` layout are ready for normal
  `ops/deploy-poc` releases; Caddy never needs write access to deployed assets.
- Jobs run as the dedicated `codex-runner` user. Runtime state and subscription
  auth live under its isolated run home; projects live under
  `/srv/codex-workspaces`.
- Codex uses the runner's direct Codex subscription. GPT-5.6 Sol, Terra, and
  Luna are first-class catalog entries for task mode and Codex-backed chat.
- Claude Code now uses the corrected first-party direct subscription. Direct CLI
  calls and live Relay API jobs succeeded for Sonnet, Opus, and Haiku. The
  default has no `CLAUDE_AWS_PROFILE`, no inherited AWS profile, and no Bedrock
  chat entry.
  If Bedrock is ever explicitly restored, the existing guard still permits only
  `CLAUDE_AWS_PROFILE=sigiq`; it is not part of this rollout.
- Cursor Agent is installed and authenticated with its direct subscription under
  the runner home. A live Relay API Cursor job succeeded, and a physical iPhone
  Relay Task using Cursor Auto completed and displayed its result. Do not replace
  that auth with a client-supplied token or an iPhone secret.
- The live catalog has seven entries: Codex Sol/Terra/Luna (`chat` + `task`),
  Cursor Auto (`task`), and Claude Sonnet/Opus/Haiku (`task`).
- Azure OpenAI-compatible bearer support is implemented, but no Azure entries
  are enabled. The pasted keys were exposed and must be rotated before their
  replacements are installed in server-side key files. Keys never appear in
  source, manifests, model API responses, logs, or this plan.
- The server already has registered/dynamic workspace selection, folder
  creation, task jobs, thread history, Codex chat support, and the provider seam
  for Cursor. The revamp extends that baseline instead of rebuilding it.

## Decisions

1. **Keep the `/srv/codex-workspaces` jail.** Add file listings and file viewing
   without allowing arbitrary paths. File content is read-only in v1. Existing
   safe folder creation remains; file edits, deletes, uploads, and moves happen
   through an agent unless separately designed.
2. **Files-first app shape.** Open into the file browser. Library and
   Status/Diagnostics remain secondary destinations behind a root toolbar menu.
   Library continues consuming the signed same-host manifest and same-host POC
   paths; the revamp does not restore wildcard POC URLs.
3. **Three proven subscription agents.** Codex, Claude Code, and Cursor Agent
   are live task providers. Codex also powers direct-subscription chat. Azure
   profiles may add plain OpenAI-compatible chat only after key rotation and
   server-side installation; Bedrock stays hidden while SigiQ is unconfigured.
4. **One folder conversation surface.** The picker groups task-capable agents
   separately from chat models. Plain chat threads acquire a `workspaceId` and
   appear with agent threads for that folder.
5. **Provider availability must be truthful.** A model/provider is advertised
   only after its on-box CLI or upstream route passes a smoke test as
   `codex-runner`. Missing auth hides that provider instead of showing a broken
   row.

## Security invariants

- No Tailscale dependency or Tailscale address is added to app configuration,
  gateway configuration, provisioning, or verification.
- mTLS remains the only network authentication for Relay; no Relay account or
  bearer token is added.
- Keep `/srv/poc-vault` read-only inside Caddy and preserve signed-manifest
  verification in Relay. Static deploy writes stay limited to the dedicated
  deploy path used by `ops/deploy-poc`.
- The phone never sends a path outside the jail. Every server path is resolved
  and realpath-contained before use.
- The server never sends provider credentials to the phone. Direct CLI
  subscription state stays in the isolated runner home; Azure keys stay in
  root-owned `0600` files.
- List/read endpoints are bounded and report pagination or truncation.
- Branding remains Relay. Bundle ID, target names, and internal paths remain
  unchanged.
- The chat editor retains interactive scroll dismissal, dismissal on Send/Run,
  and outside-tap dismissal on non-editor content. It has no custom keyboard
  accessory or floating dismiss control.

## Target UX flow

```text
App launch
  `- File browser at /srv/codex-workspaces
      |- tap folder -> drill in
      |- tap file   -> read-only viewer
      |- create     -> safe folder creation only
      |- toolbar ... -> Library | Status | Diagnostics
      `- toolbar keyboard -> conversation for THIS folder
           |- Agents: Codex | Claude Code | Cursor Agent
           |- Chat models: Codex GPT-5.6 Sol/Terra/Luna | enabled Azure (none now)
           |- agent -> async job, live output, cancel, continue
           |- chat  -> saved workspace-scoped conversation
           `- Threads -> conversations and invocations for this folder
```

## Workstreams

| Track | Milestones | Summary |
|---|---|---|
| **S — Server** ([detail](01-server-plan.md)) | S1 Files API · S2 Workspace-scoped chat · S3 Cursor hardening · S4 Job streaming/concurrency | Additive changes on the existing isolated runner; provider/auth and mTLS behavior remain backward compatible |
| **I — iOS** | I0 extraction · I1 file models/client · I2 browser root · I3 file viewer · I4 per-folder conversation · I5 remove dead console | Rebuild navigation around a `NavigationStack` file browser and reuse the current Relay networking and identity stack |

## Sequencing

```text
Freeze the deployed provider/model contract
  |- S1 files API + simulator parity -> I0 -> I1 -> I2 -> I3
  |- S2 workspace-scoped chat ---------------------------> I4
  |- S3 preserve proven Cursor contract -----------------> I4
  `- S4 live job stream ---------------------------------> I4 -> I5
```

Every server milestone is additive. The existing app must continue to work at
each step. Catalog changes are operational configuration, but they are enabled
only after provider-specific live verification.

## Verification

- **Server:** `node --check` and `node --test` for the server plus focused
  renderer tests. Fake Codex/Claude/Cursor binaries must not require real auth.
- **Provider catalog:** preserve the proven seven-entry live catalog and rerun
  direct-subscription smoke tests after provider/runtime changes. Azure remains
  absent until every exposed key is rotated and each replacement route passes
  through its server-side key file.
- **Simulator:** extend `ops/serve-simulator-poc-vault` for files, scoped chat,
  Cursor, and job SSE before the matching iOS milestone.
- **Live:** deploy to `pariksj-dev`, validate Caddy, keep port 8787 private,
  confirm public health, confirm unauthenticated API rejection, then run the API
  smoke matrix with both allowed client identities.
- **Static POCs:** render/sign the five-item manifest, deploy through
  `ops/deploy-poc`, and verify `/manifest.json` plus representative
  `/pocs/<slug>/` pages are 403 without a cert and 200 with both identities.
  Do not add wildcard-host verification.
- **Device:** preserve the physical-iPhone Cursor Auto proof as a regression
  check, provision the same client identity and live Relay base URL, and
  rebuild/install only when iOS changes land. The model list must contain only
  providers that passed the live smoke matrix.

## Top risks

1. **Cursor CLI contract drift.** Pin the invocation to the installed
   `cursor-agent --help` output and a real direct-subscription smoke job; do not
   assume `create-chat` or `--list-models` exists.
2. **Subscription-state isolation.** Copying a personal home wholesale would
   violate the runner boundary. Preserve the now-working first-party CLI auth
   state in the runner home and keep permissions narrow.
3. **File-read exposure.** mTLS operators can already ask agents to read files,
   but the new HTTP surface still needs a denylist, byte caps, no-store headers,
   and realpath containment.
4. **SSE lifecycle on iOS.** Streams can die in the background; reconcile with
   polling on foreground.
5. **Concurrency pressure.** Measure on the current `pariksj-dev` instance and
   keep the limit at 1 or 2 until parallel Codex/Claude/Cursor runs are proven.
6. **Azure profile drift.** Deployment names, quotas, and replacement keys can
   change; after rotation, validate each route without logging credentials and
   hide failed entries.
