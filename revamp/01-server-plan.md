# Track S — Server Plan

Updated 2026-08-09. This plan starts from the current `pariksj-dev` Relay
backend rather than the old Bedrock-first deployment.

The implementation remains the zero-dependency Node server in
`codex-server/codex-api-deploy/server.mjs`, its `node --test` suite, config
rendering in `ops/render-codex-api-config`, and simulator parity in
`ops/serve-simulator-poc-vault`. Each milestone must be independently
deployable and preserve the current iPhone app contract.

## Deployed architecture to preserve

- Gateway: `https://relay.65-2-161-233.sslip.io` through Caddy on
  `pariksj-dev`. Do not introduce Tailscale or a Tailscale hostname.
- `/healthz` stays public. `/v1/codex/*` stays mTLS-only for exactly
  `CN=iphone` and `CN=parikshit-mac`, with gateway verification and backend
  subject re-check.
- Node listens on the private instance address/port 8787; it is not exposed by
  a security-group rule.
- The same Caddy host also serves the static POC system from a read-only
  `/srv/poc-vault` mount: the signed five-item manifest is `/manifest.json` and
  POCs are `/pocs/<slug>/`. Wildcard POC hosting is disabled.
- Static manifest/POC requests are 403 without a certificate and 200 with the
  Mac or iPhone certificate. The iPhone support config carries the matching
  manifest public key.
- Static releases use the dedicated deploy user/key and established
  `/srv/poc-vault` layout through `ops/deploy-poc`; the agent API service and
  Caddy do not gain deployment write access.
- Jobs run as `codex-runner`, with isolated runtime/subscription state and
  workspaces rooted at `/srv/codex-workspaces`.
- Codex direct subscription provides GPT-5.6 Sol, Terra, and Luna. Those models
  are supported in task mode and in the existing Codex-backed chat route.
- Claude Code uses the corrected first-party direct subscription. Direct CLI
  calls and live Relay API jobs have succeeded for Sonnet, Opus, and Haiku.
  Keep `CLAUDE_AWS_PROFILE=` and `CLAUDE_CODE_USE_BEDROCK=` by default, and
  scrub ambient AWS variables from direct Claude jobs. The existing boot guard
  may permit only an explicitly configured SigiQ profile if Bedrock is
  deliberately restored later.
- Cursor is the live third Task provider (`cursor`). It is installed and
  authenticated under the runner's direct Cursor subscription. A live API job
  and a physical-iPhone Relay Task using Cursor Auto both succeeded. Its auth is
  runner state, not a Relay/iPhone token.
- Azure OpenAI-compatible models use per-catalog `azureBaseURL` and
  `azureApiKeyFile`; upstream authentication is `Authorization: Bearer`. Key
  files are root-owned `0600` operational inputs and are never returned by the
  model endpoint. No Azure entry is live until the exposed pasted keys are
  rotated and replacement keys are installed this way.

## Already implemented foundation

Do not schedule these as greenfield work:

- registered workspaces plus safe dynamic selection under the workspace root;
- directory browsing and safe folder creation;
- async Codex/Claude jobs, continuation, cancellation, history, and artifacts;
- synchronous chat persistence and SSE;
- direct Codex chat using the selected GPT-5.6 catalog model in a read-only,
  ephemeral run;
- Codex/Claude/Cursor provider seams in model validation, job execution,
  filters, and skill lookup;
- an installed/authenticated Cursor runner plus proven live API and physical
  iPhone Cursor Auto jobs;
- corrected direct Claude auth plus proven Sonnet, Opus, and Haiku CLI/API jobs;
- Azure catalog descriptors with per-model base URLs and key-file references,
  with zero Azure entries currently enabled pending key rotation.

## Model and provider contract

The live `/v1/codex/models` catalog contains exactly seven entries:

- Codex GPT-5.6 Sol, Terra, and Luna, each with `chat` and `task` modes;
- Cursor Agent Auto with `task` mode;
- Claude Code Sonnet, Opus, and Haiku, each with `task` mode.

Azure and Bedrock contribute no current live entries.

### Codex

The installed direct-subscription Codex runner currently advertises:

| Catalog label | Provider | Modes | Runner model |
|---|---|---|---|
| Codex · GPT-5.6 Sol | `codex` | `chat`, `task` | `gpt-5.6-sol` |
| Codex · GPT-5.6 Terra | `codex` | `chat`, `task` | `gpt-5.6-terra` |
| Codex · GPT-5.6 Luna | `codex` | `chat`, `task` | `gpt-5.6-luna` |

The phone receives names and capabilities, never Codex auth state. Chat stays
read-only and ephemeral; task mode retains the selected workspace and normal
agent tools.

### Claude Code

Claude is a task provider authenticated by corrected first-party direct
subscription state under the runner home. Sonnet, Opus, and Haiku are proven by
direct CLI calls and live Relay API jobs; they are CLI aliases, not proof of
Bedrock access. No Claude/Bedrock chat model is advertised while SigiQ is absent.

Direct jobs must remove `AWS_PROFILE`, `AWS_DEFAULT_PROFILE`, access-key
variables, AWS regions, and `CLAUDE_CODE_USE_BEDROCK`. If an operator later
chooses Bedrock explicitly, startup still rejects every AWS profile except
`sigiq`.

### Cursor Agent

Cursor is a proven task provider authenticated by Cursor's direct subscription
under the isolated runner home. Cursor Auto succeeded through the live API and
from the physical iPhone app. Do not make `CURSOR_API_KEY` the default plan and
do not send Cursor credentials through Relay.

The current implementation uses this on-box-verified invocation contract:

```text
cursor-agent -p --force --trust --workspace <workspace> --output-format json \
  [--model <model>] [--resume <session>] <prompt>
```

Keep `cursor-agent --help`, a fresh smoke job, its JSON result shape, and a real
continuation as regression sources of truth. Do not regress to previously
assumed `agent --list-models` or `agent create-chat` commands. Cursor Auto is the
only enabled Cursor catalog entry until another model ID is proven live.

### Azure OpenAI-compatible chat

Azure profiles can become ordinary chat providers routed by server-side catalog
metadata. Support is coded, but the live catalog intentionally has no Azure
entry because the pasted credentials were exposed. Rotate them before any
installation or smoke test:

```json
{
  "id": "azure-<deployment>",
  "provider": "azure",
  "modes": ["chat"],
  "azureDeployment": "<deployment>",
  "azureBaseURL": "https://<resource>/openai/v1",
  "azureApiKeyFile": "/etc/codex-api/azure/<profile>.key"
}
```

Never reuse an exposed key or put a live key in JSON, source, example env files,
process arguments, log output, or API responses. After rotation, installation
copies replacement key files to a root-only directory and the server reads the
selected file only when making the upstream bearer-authenticated request.
Validate every route independently before adding it to the catalog.

---

## S1 — Bounded read-only Files API

Add `/v1/codex/fs/list` and `/v1/codex/fs/file`; keep the existing
`/v1/codex/workspace-dirs` response backward compatible because the installed
app treats every entry there as a directory.

### Shared path rules

- Generalize the existing directory resolver to accept `dir`, `file`, or any
  path kind.
- Resolve real paths and reject traversal, absolute paths outside the root, and
  symlinks escaping `/srv/codex-workspaces`.
- Avoid repeated root `realpath` calls and repeated linear workspace scans while
  listing a directory.
- Continue supporting safe folder creation through the existing endpoint. The
  new file surface adds no edit, delete, move, or upload operation.

### `GET /v1/codex/fs/list`

Parameters: `path`, `offset`, and `limit`.

Return dirs first, then files by name. Include `kind`, relative/absolute path,
size for files, modification time, conservative MIME/type hints, workspace/git
metadata for directories, and `readDenied` for protected names. Include
`offset`, `limit`, `total`, and `truncated`; never silently cap a listing.

List dotfiles but deny HTTP reads for high-value secret patterns by default,
including `.env*`, private-key/certificate files, `.netrc`, and credential
files. This is defense-in-depth, not a replacement for mTLS or runner isolation.

### `GET|HEAD /v1/codex/fs/file`

- Reject anything outside the jail, non-regular files, and denylisted names.
- Send `cache-control: no-store`, `x-content-type-options: nosniff`, and a safe
  content disposition.
- Bound a response to 1 MiB and support byte ranges for larger permitted files.
- Enforce an absolute maximum file size for download/preview.
- Treat HTML/SVG as downloads unless the existing sandboxed preview mechanism
  is explicitly requested.

### S1 verification

Cover traversal, symlink escape, denylist, dotfiles, pagination, HEAD, range,
206/416, MIME/disposition, byte limits, and an unchanged legacy
`workspace-dirs` response. Mirror the route and representative fixture files in
the simulator server.

---

## S2 — Workspace-scoped chat threads

1. Let `POST /v1/codex/chat` accept `workspaceId` and resolve it through the
   same registered/dynamic workspace registry as jobs.
2. Persist the resolved workspace ID/name. A continuation may omit the ID and
   inherit the stored value, but a conflicting ID must fail.
3. Merge chat and task threads when `/v1/codex/threads?workspaceId=...` is used.
   Legacy chats without a workspace remain only in the global list.
4. Make summaries, details, provider filters, and scoped deletion preserve the
   workspace fields.
5. For Codex chat, use the selected workspace as the read-only cwd instead of
   always falling back to `scratch`; Azure remains context-only unless folder
   context is explicitly and safely designed.

Back compatibility: the installed app may omit `workspaceId`, preserving its
current global-chat behavior. Add focused tests for inheritance, mismatch,
mixed task/chat sorting, provider filters, and legacy null-workspace threads.

---

## S3 — Cursor direct-subscription regression hardening

The provider seam, direct subscription, server job, and physical-iPhone Cursor
Auto path are already proven. This milestone protects that contract during the
files/chat revamp.

1. Preserve the installed `cursor-agent`, verified `CURSOR_BIN`, and direct
   subscription state inside the `codex-runner` boundary. Record no credential
   material in repository files or service logs.
2. Pin tests to the proven non-interactive arguments and output shape. Recheck
   exit behavior, cancellation signals, and resume identifiers after every
   Cursor CLI upgrade before changing `buildCursorArgs` or result parsing.
3. Scrub ambient AWS credentials for Cursor just as for direct Claude; pass
   only the runner home, normal PATH, and necessary non-secret process config.
4. Keep only the live-verified `Cursor Agent · Auto` entry. Add another model
   only after a real authenticated job proves its ID.
5. Keep Cursor skills under explicit `CURSOR_SKILL_DIRS` or the isolated runner
   home. Apply the same bounded skill-file reads used by other agents.

Tests use a fake Cursor binary that matches the verified argv and output shape,
including fresh run, continuation, cancellation, model argument, malformed
JSON, nonzero exit, and provider/thread filters. The fake never reads real
subscription state.

---

## S4 — Live job streaming and measured concurrency

Add:

```text
GET /v1/codex/jobs/<id>/stream?stdoutOffset=<n>&stderrOffset=<n>
```

SSE events:

```text
status  -> job status snapshot
stdout  -> byte offset plus text
stderr  -> byte offset plus text
done    -> terminal job response
```

- Replay bounded persisted logs from requested offsets, then follow live data.
- Emit heartbeats and unsubscribe immediately when the client disconnects.
- Preserve valid UTF-8 across chunk boundaries.
- Keep polling `GET /jobs/<id>` as the foreground/background recovery path.
- Make the development proxy stream `text/event-stream` instead of buffering.
  The live gateway is Caddy, not nginx; validate streaming through Caddy and do
  not add nginx-specific assumptions to the rollout.

Keep `CODEX_MAX_CONCURRENT=1` until live measurements show safe parallel Codex,
Claude, and Cursor jobs. Increase to 2 first. Only consider 3 after measuring
memory, cancellation, and same-workspace continuation behavior on
`pariksj-dev`.

---

## S5 — Rollout checklist

1. Run `node --check` and the complete `node --test` suite after each server
   milestone; run renderer syntax/tests and simulator checks for config changes.
2. Render `/etc/codex-api.env` without credentials in the catalog. Keep Azure
   absent until the exposed keys are rotated; then install replacement bearer
   keys separately as root-owned `0600` files.
3. Validate the Caddy configuration, restart only the necessary service, and
   confirm port 8787 remains private.
4. Verify public `/healthz` returns 200 and unauthenticated `/v1/codex/*` is
   rejected.
5. Verify the signed `/manifest.json` and representative `/pocs/<slug>/` pages
   are 403 without a certificate and 200 with both allowed identities. Confirm
   Caddy still mounts `/srv/poc-vault` read-only and do not add wildcard hosts.
6. With both allowed client identities, verify models, workspaces, threads, and
   job creation against `https://relay.65-2-161-233.sslip.io`.
7. As `codex-runner`, smoke-test:
   - Codex Sol/Terra/Luna task selection and Codex chat;
   - direct Claude Sonnet, Opus, and Haiku jobs with no AWS environment;
   - direct Cursor Auto fresh and continuation jobs using the verified CLI
     contract;
   - every enabled Azure route via a rotated replacement key file, without
     logging key content. Until rotation, assert there are no Azure entries.
8. Verify files list/read/range and a running job stream over the live Caddy
   path, then rebuild/install Relay only when the matching iOS changes are
   ready.
9. Use `ops/deploy-poc` and its dedicated deploy identity for future static POC
   changes; do not write into the Caddy mount through the agent service.
10. Do not add Tailscale routes, wildcard POC DNS/hosting, or public port 8787
    security-group rules.

## Risks

1. **Cursor CLI drift:** the installed authenticated binary, not old web docs,
   defines argv and result parsing.
2. **Provider auth leakage:** runner homes and Azure key files need narrow
   ownership; diagnostics must contain only redacted metadata.
3. **Scoped chat semantics:** task agents have folder access, while Azure chat
   does not automatically receive file content. The UI must not imply otherwise.
4. **SSE interruption:** app backgrounding can close streams; polling remains
   authoritative for recovery.
5. **Parallel workspace mutations:** concurrency can race agents in one folder;
   raise the limit only with live evidence.
6. **File HTTP exposure:** denylist and size limits are hygiene on top of mTLS,
   not a complete secret-classification system.
7. **Azure deployment drift:** model routes and quota are independently mutable;
   rotated replacements must be revalidated and failed profiles hidden without
   breaking direct Codex chat.
