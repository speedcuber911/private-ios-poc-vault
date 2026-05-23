# POC Vault Project History

This document records what has happened in this repository and why the system
looks the way it does today. It is intentionally more narrative than the root
README: use the README to operate the project, and use this file to understand
the evolution, tradeoffs, and current boundaries.

## Current Shape

POC Vault is a private static POC delivery system plus a phone-controlled remote
agent runner.

The repository now contains four connected surfaces:

- `pocs/`: self-contained static demos, one folder per slug.
- `ops/`: local and remote operational tooling for rendering manifests,
  signing them, deploying static assets, provisioning support files, and
  verifying live mTLS behavior.
- `ios/POCVault/`: the SwiftUI vault shell that loads the signed manifest,
  opens POCs in an authenticated WebView, and exposes a Codex/Claude console.
- `codex-server/`: the EC2-side async job API that lets the phone start,
  inspect, continue, and cancel agent runs in registered server workspaces.

The most important architectural decision is still that ordinary POC creation is
backend-driven. A new POC should be a static folder and metadata entry under
`pocs/<slug>/`, deployed through `ops/deploy-poc`. It should not require native
iOS code.

## Timeline

### 1. Sanitized Static Vault Foundation

The repo began as a sanitized private POC hosting platform. The initial shape
included:

- a SwiftUI iOS shell under `ios/POCVault/`
- signed manifest rendering and verification
- a static POC layout under `pocs/<slug>/public/`
- deploy, certificate, server-install, simulator, and verification scripts in
  `ops/`
- a first `smoke-test` POC
- a repo-level security contract in `SECURITY.md`

That first foundation established the durable model: static demos are discovered
from a manifest rather than compiled into the app.

### 2. Operational Hardening

The first hardening pass made the vault safer to operate from agents and from a
local Mac:

- `AGENTS.md` was expanded into a repo contract for future workers.
- `ops/deploy-poc` learned stricter validation for slugs, staged files, and
  risky secret-like content.
- client certificate generation rejected empty `.p12` passphrases.
- nginx templates and verification scripts were adjusted around the live mTLS
  boundary.
- ignored local artifacts such as deployment logs and generated build outputs
  were kept out of normal publish flows.

The security wording was tightened at the same time: access is based on valid
client certificates. It is private, but it is not automatically
hardware-bound to one iPhone.

### 3. Codex Job Server

The next major addition was `codex-server/`, a Node-based async job API deployed
on the EC2 host. It added:

- authenticated `/v1/codex/*` routes behind nginx mTLS
- a public `/healthz`
- persistent jobs, stdout/stderr/result files, and audit JSONL
- FIFO execution with timeout and cancel support
- a workspace registry instead of arbitrary phone-supplied paths
- systemd/nginx deployment assets under `codex-server/codex-api-deploy/`

The service exists inside this repo because the iOS shell, the EC2 runner, and
the static vault are one operational unit. The phone can control only registered
workspace ids such as `scratch` and `poc-vault`.

### 4. iOS Codex Console

The iOS app then gained a Codex tab. The first version could:

- list workspaces and jobs
- submit prompts to the EC2 job API
- show job state, output, and errors
- cancel or retry jobs
- use the same imported client identity as the POC WebView flow

The UI later moved away from infrastructure-heavy cards and toward the current
phone-first console: prompt entry, compact controls, thread/result browsing, and
collapsible details.

### 5. Static POC Catalog Growth

Several static demos were added to prove the deploy and manifest path:

- `smoke-test`
- `bmw-i7-m4-acceleration`
- `india-ctc-calculator`
- `sfs-data-readiness`
- `sfs-leap-workbench`

Later local work added additional POCs:

- `ai-tutor-product-expert`
- `sigiq-contributions-parikshit`

These demos all follow the same contract: source metadata in `poc.json`, static
assets in `public/`, and generated file hashes/URLs only in the rendered
manifest.

### 6. Thread Summaries And Bounded Output

The Codex surface evolved from raw jobs into resumable thread history. The
server now exposes metadata-only sessions and safe thread summaries:

- `/v1/codex/sessions`
- `/v1/codex/threads`
- `/v1/codex/threads/<sessionId>`

The implementation intentionally bounds default payloads. List and detail
responses expose previews and metadata by default, while full stdout/stderr/log
payloads are fetched only on explicit request. This was added to keep the phone
usable on long agent runs and to avoid crashing or freezing the UI with huge
logs.

The thread summarizer also skips injected AGENTS/environment preambles and
strips skill-selection prefixes so the iOS thread list reads like user work,
not runtime scaffolding.

### 7. Physical Device Identity Fixes

The real device workflow was tightened around the canonical bundle id:

```text
com.parikshit.pocvault
```

The stale `com.example.pocvault` installation path was treated as a real device
state problem rather than a source-only problem. The intended physical-device
flow is now:

- build/install the canonical bundle id
- provision `Documents/support/client.p12`
- optionally provision `Documents/support/vault-config.json`
- import or recover the `CN=iphone` identity in Diagnostics
- confirm the Keychain identity is healthy before debugging backend code

`ClientIdentityStore` was also improved so the app can recover an existing
Keychain identity after reinstall or app-container churn instead of forcing a
fresh manual import every time.

### 8. Local Notifications

The app added local completion notifications for observed Codex activity. This
is deliberately not a full APNs path. The current behavior depends on app-side
polling and notification scheduling for jobs or threads the app has seen.

If true remote push is needed later, that will require device-token
registration, backend push fan-out, APNs credentials, and a different delivery
contract.

### 9. Remote Runner Disk Hardening

The live runner hit a disk-space failure mode where runtime caches under the
Codex service home consumed space and jobs failed with `ENOSPC`. The operational
lesson was that logs are not the only disk risk; runtime caches under
`/var/lib/codex-api/run-home` also need pruning and environment discipline.

The expected recovery proof is a fresh authenticated job succeeding after cache
cleanup, plus `systemctl is-active codex-api` and `nginx -t` staying healthy on
the host.

### 10. Multi-Install Packaging

The repo was then made reusable for another owner or install. Owner-specific
values moved out of tracked files and into:

```text
~/.poc-vault/secrets/config.env
```

The portable install flow now includes:

- `ops/init-install-config`
- `ops/render-codex-api-config`
- `ops/install-server.sh`
- `ops/install-codex-api.sh`
- `ops/provision-ios-support.sh`
- `docs/MULTI_INSTALL.md`

The repo keeps example/default values generic. Real domains, bundle ids,
certificate subjects, keys, AWS settings, Azure Speech credentials, and Codex
auth state remain per-owner.

### 11. Voice Prompt Transcription

The phone console gained microphone support for prompt and reply composition.
The iOS app records short WAV clips and uploads them to:

```text
POST /v1/codex/transcriptions
```

The server forwards those clips to Azure Speech when configured. Audio upload
uses the same mTLS boundary as the rest of `/v1/codex/*`; Azure endpoint and key
values belong only in server-side environment files.

### 12. Provider Expansion And Browser Review

Recent work expanded the remote runner from Codex-only to a provider-aware
Codex/Claude service:

- `POST /v1/codex/jobs` accepts `provider`
- `provider=codex` remains the default
- `provider=claude` runs the configured Claude binary in print mode
- sessions, jobs, threads, and thread detail support provider filters
- resume is provider-locked so a Claude thread cannot be continued by Codex and
  vice versa

The server also gained an authenticated browser review UI at:

```text
GET /v1/codex/ui
```

For local browser tooling that cannot present a client certificate directly,
the Node service can proxy live read requests using configured client cert/key
paths. Those proxy cert paths must stay local or server-side and must never be
committed.

### 13. Current iOS Console Direction

The current iOS console is a provider-aware control surface. The app can show
Codex and Claude affordances, select models and effort/reasoning levels, record
voice prompts, browse threads, and open bounded detail views.

Codex-specific skills remain client-side prompt decoration. Selecting skills
adds a text prefix to the prompt; it does not create a new backend contract.

The phone UI should stay simple: prompt plus results, with compact controls and
thread detail when needed. Avoid reintroducing endpoint cards, workspace cards,
offline labels, or broad infrastructure controls unless the user explicitly
asks for them.

## Security Decisions

The live system is private because protected routes require mTLS:

- static manifest routes require a valid client certificate
- POC pages require a valid client certificate
- `/v1/codex/*` requires mTLS and exact subject allowlisting
- `/healthz` remains public

This does not mean "iPhone-only." Any holder of an accepted client certificate
can access protected routes. The wording matters because the Mac may also have
operator certificates for verification.

For this live install, the Codex API allowlist should stay exactly:

```text
CN=iphone
CN=parikshit-mac
```

Generic installs can choose their own subjects through
`CODEX_ALLOWED_CERT_SUBJECTS`; examples in multi-install docs use placeholder
operator subjects.

The Codex API adds a second check behind nginx: the backend verifies forwarded
certificate status and subject headers before handling `/v1/codex/*`.

The runner must stay constrained:

- no arbitrary workspace paths from the phone
- no access to POC Vault private keys
- no committed Codex auth JSON
- no committed Azure Speech keys
- no committed client certificates or signing private keys

## Operational Contracts

Use `ops/deploy-poc` for ordinary POC deployment. It is the canonical path for
validation, staging, manifest rendering, signing, logging, rsync, and remote
promotion.

Use `ops/verify-server.sh` for live perimeter checks. It reads local deployment
values from `~/.poc-vault/secrets/config.env`, so callers do not need to paste
domains, certificate paths, or hostnames into docs or terminal output.

Use `ios/launch-simulator.sh` for simulator validation. Simulator mode is a
local preview path and intentionally bypasses production mTLS.

Use `codex-server/codex-api-deploy/server.test.mjs` for server contract checks.
The most useful local gate is:

```bash
cd codex-server/codex-api-deploy
node --check server.mjs
node --test server.test.mjs
```

## What To Keep Out Of Future Changes

Do not make ordinary POC deployment depend on `ios/POCVault/`.

Do not put per-owner settings into tracked files. Use local config and renderers.

Do not describe the system as hardware-bound to the iPhone unless the key
material is actually generated and retained only there.

Do not let the phone send arbitrary paths to the remote runner.

Do not make session or thread list endpoints return raw transcript/log blobs by
default. Keep bounded previews as the default and make full logs explicit.

Do not hand-edit generated manifest fields into `pocs/<slug>/poc.json`.

## Reading Map

- [README.md](../README.md): how to understand and operate the project.
- [SECURITY.md](../SECURITY.md): secret handling and access model.
- [docs/IMPLEMENTATION.md](IMPLEMENTATION.md): current implementation shape.
- [docs/MULTI_INSTALL.md](MULTI_INSTALL.md): new-owner install flow.
- [codex-server/README.md](../codex-server/README.md): Codex/Claude API runtime.
- [codex-server/codex-api-deploy/README.md](../codex-server/codex-api-deploy/README.md): deployable server files.
- [AGENTS.md](../AGENTS.md): rules for future AI workers in this repo.
