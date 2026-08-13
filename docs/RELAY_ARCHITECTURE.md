# Relay — architecture and hosting

> Live map of what runs where, and which trust boundary each piece sits on.
> Verified against AWS and the running hosts on 2026-08-13.

## The one-paragraph version

A laptop CLI (`relay`) seals a stopped coding session, pushes the ciphertext to
**GitHub** on a `relay/handoff-*` branch, and tells a **control plane** only the
names involved. The user's **sandbox** picks the work up over a long-poll,
clones the branch, decrypts it with a key the control plane never holds, and
continues the session. The **iOS app** talks to that sandbox directly over
mTLS, and uses the control plane only for accounts, push routing and pairing.
The control plane is deliberately not a party to any conversation.

## Trust boundaries

This is the part worth internalising: four parties, and each one is told the
least it can function on.

| Party | Learns | Never learns |
|---|---|---|
| **GitHub** | that a branch exists, and ciphertext | anything about the session — the blob is X25519 + HKDF-SHA256 + AES-256-GCM (`RLYSEAL1`) |
| **Control plane** | names only: repo full name, branch, node id, handoff id, event types | transcripts, prompts, manifests, provider credentials, decryption keys |
| **Apple (APNs)** | event type, ids, and — deliberately — the repo and branch in a handoff banner | everything else; the payload is built field-by-field, never from what a node sends |
| **Sandbox** | everything, because it is the user's machine | — |

Two consequences that are easy to get wrong and are enforced in code:

- The **decryption key never reaches the control plane.** The CLI seals to the
  node's X25519 public key; only the node can open it.
- The **cloud is content-free by construction, not by convention.**
  `POST /v1/handoffs` accepts four names and nothing else; the push payload is
  assembled from validated fields, so a misbehaving node cannot smuggle prose
  through it.

## Components

| Component | Where it runs | What it is |
|---|---|---|
| `relay` CLI | user's laptop | Zero-dependency Node. Seals the session, pushes the branch, registers the handoff, waits for a terminal state. `product/cli/` |
| relay-cloud | `poc-ec2` | Accounts, entitlements, devices, nodes, handoff state machine, rendezvous, APNs fanout, trial provisioning. SQLite. `product/cloud/` |
| relayd | inside each sandbox | The node daemon: jobs, workspaces (jailed), handoff import, credential install, harness adapters. `product/relayd/` |
| broker | `relay-router` | Tunnel between the phone and a node. `product/broker/` |
| trial image | built on the Cube host | Debian + node + Codex/Claude/Cursor CLIs + relayd. `product/trial/` |
| iOS app (Relay) | phone | mTLS client to the node; control plane only for auth, pairing and push. `ios/POCVault/` |

## AWS — one account, not two

Everything Relay is lives in **`507121383669`**, region **`ap-south-1`**
(the `default` CLI profile).

| Instance | Role |
|---|---|
| `poc-ec2` · `i-0ce97c38c7fd74825` · t3.large · 43.204.94.3 | **Control plane.** nginx terminates public TLS for `relay.ai-rocket-experiments.com` and proxies to `127.0.0.1:8790`. SQLite at `/var/lib/relay-cloud/`, backed up to S3 on a timer |
| `rocketizer-cubesandbox` · `i-077519030563ae4a8` · m6i.2xlarge · no public IP | **Sandbox host.** Cube (E2B-API-compatible) microVMs, the local image registry on `:5000`, and the Cube API on `:3000`. Trial sandboxes are snapshot-restored microVMs here |
| `relay-router` · `i-0c23c6701070f68b3` · m4.large | **Broker.** Phone ⇄ node tunnel |
| `pariksj-dev` · `i-0364bb0f31f506e7c` · m4.large · 3.111.143.88 | Owner's personal dev box. **Not part of the product** — but it serves `codex.pocs.conformal.live`, which was the checked-in iOS default until 2026-08-13 |

Supporting resources, same account: Route 53 zone `ai-rocket-experiments.com`;
`relay-cloud-cicd-507121383669-ap-south-1` (release artifacts);
`relay-poc-backups-507121383669-ap-south-1` (SQLite backups, versioned,
block-public-access, SSE-S3).

**The second account is not Relay.** `992203938018` (profile `cut-personal`)
runs `cutcompanion-backend` — a different product. No Relay component depends on
it, and nothing in this repo deploys there. If you were expecting Relay to span
two accounts, it does not; the split is by product, not by environment.

Access to both hosts is **AWS SSM only** — no inbound SSH, and the control
plane's listener is loopback-bound.

## How a handoff actually flows

```
laptop                    GitHub          control plane            sandbox            phone
  │                          │                  │                     │                 │
  │ relay handoff            │                  │                     │                 │
  │  seal → RLYSEAL1         │                  │                     │                 │
  ├─ push relay/handoff-* ──►│                  │                     │                 │
  ├─ POST /v1/handoffs ──────┼─────────────────►│  (names only)       │                 │
  │                          │                  ├─ wakes long-poll ──►│                 │
  │                          │◄─────────────────┼──── git clone ──────┤                 │
  │                          │                  │   decrypt (node key)│                 │
  │                          │                  │◄── ready ───────────┤                 │
  │                          │                  ├─ APNs ──────────────┼────────────────►│
  │◄─ polls to ready/failed ─┼──────────────────┤                     │◄─ mTLS fetch ───┤
```

The CLI waits for a terminal state rather than exiting at the cloud's `201` —
`delivered` is written on lease-ack *before* the import runs, so it never meant
success. `ready` and `failed` are the only honest answers.

## Handoff state machine

```
pending ──lease──► leased ──ack──► delivered ──┬──► ready
                      │                        └──► failed
                      └── lease expires ──► pending
```

A poll response reaching `res.end()` is not proof it arrived — a partitioned
peer sees no FIN. So a poll **leases** rather than delivers, and
`POST /v1/node/handoffs/ack` with a single-use lease token is the only thing
that confirms it.

## Push notifications

Node → cloud events are signed (detached ed25519 over the raw body) and carry
`{v, nodeId, jobId, type, ts, seq}` — no text at all. `seq` is the replay key.

The **banner** is built by the cloud from its own tables, never from the event.
A handoff banner names the repo and branch; everything else is a fixed string
per event type. That repo/branch disclosure to Apple is deliberate and is the
only content in the payload.

Each device is pushed to **its own APNs host**, chosen from
`devices.apns_environment`, because a token is only valid against the
environment of the build that minted it. `NULL` means the app did not report
one and falls back to the configured `APNS_HOST`.

## Deployment

Control plane releases go **tar → private S3 → SSM → `install.sh`**, via
`product/cloud/deploy/cicd-deploy.sh`. Releases are content-addressed by git
SHA under `/opt/relay-cloud/releases/<sha>` with a `current` symlink, so
rollback is a symlink flip plus a restart. A CodeCommit/CodePipeline path also
exists (`relay-cloud-cicd`) but the recent releases were deployed by invoking
the script directly.

Trial images are built **on the Cube host** (`product/trial/build.sh`): docker
build → local registry → `POST /templates` → poll for READY. Cube ships no
`e2b` CLI, so the HTTP API is the real path. A template that is not READY fails
every sandbox create, which is why the build waits.

Note when reading build output: a template's **replica** sits at `FAILED` while
the template converges and then goes `READY`. Only the top-level status is
meaningful.

## Known gaps

- **`DEVICE_LOGIN_URL` is unset in production**, so `relay login` tells every
  user to approve at `https://relay.example/cli-login` — the `config.js`
  placeholder. The QR encodes the same dead domain.
- **No re-pair path for an existing trial node.** The rendezvous is put-once
  and `runTrialPairing` only runs at boot, so a device that loses its
  credential to a still-running machine cannot be re-issued one.
- **`sync-auth` produces no visible change.** The model catalog is built once
  at daemon boot from env vars and never inspects credentials, so a successful
  sync has nothing to show in the app. Credentials do reach jobs.
- **Deleting a trial in the app is a one-way door.** `DELETE` sets state
  `destroyed`, and only `failed` is retryable, so the button permanently burns
  the account's one trial with no in-app way back.
- **No Notification Service Extension.** `mutable-content` is set so one could
  take over the banner later and move the names back out of the payload.
- **No `relay logout`.** Nothing unbinds a CLI from an account.
