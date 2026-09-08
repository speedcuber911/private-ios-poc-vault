# Relay — architecture and hosting

> Live map of what runs where, and which trust boundary each piece sits on.
> Hosting facts verified against AWS and the running hosts on 2026-08-13. The
> bring-your-own-machine model described here landed on 2026-09-08 and is not
> deployed anywhere yet; see `docs/superpowers/specs/2026-09-08-byo-vm-simplification.md`.

## The one-paragraph version

Relay does not hand out machines. The user installs **relayd** on hardware they
already own, runs `relayd pair`, and scans the QR code it prints. The phone then
talks to that machine directly, over TLS the machine terminates itself with a
certificate signed by its own CA. Files, chat and agent runs never pass through
Relay's servers.

Separately, a laptop CLI (`relay`) seals a stopped coding session, pushes the
ciphertext to **GitHub** on a `relay/handoff-*` branch, and tells a **control
plane** only the names involved. The user's machine picks the work up over a
long-poll, clones the branch, decrypts it with a key the control plane never
holds, and continues the session. The control plane is used for accounts,
handoff routing, push and `relay login` — and for nothing else. It is not a
party to any conversation, and it is no longer on the path to using the
product at all.

## Trust boundaries

This is the part worth internalising: four parties, and each one is told the
least it can function on.

| Party | Learns | Never learns |
|---|---|---|
| **GitHub** | that a branch exists, and ciphertext | anything about the session — the blob is X25519 + HKDF-SHA256 + AES-256-GCM (`RLYSEAL1`) |
| **Control plane** | names only: repo full name, branch, node id, handoff id, event types | transcripts, prompts, manifests, provider credentials, decryption keys |
| **Apple (APNs)** | event type, ids, and — deliberately — the repo and branch in a handoff banner | everything else; the payload is built field-by-field, never from what a node sends |
| **The user's machine** | everything, because the user owns and operates it | — |

Three consequences that are easy to get wrong and are enforced in code:

- The **decryption key never reaches the control plane.** The CLI seals to the
  node's X25519 public key; only the node can open it.
- The **cloud is content-free by construction, not by convention.**
  `POST /v1/handoffs` accepts four names and nothing else; the push payload is
  assembled from validated fields, so a misbehaving node cannot smuggle prose
  through it.
- The **cloud can be absent entirely for the core loop.** Pairing is a direct
  exchange between the phone and the node; browsing files, starting a run and
  reading its output are phone-to-node requests. Sign-in buys handoff, push and
  `relay login`, and nothing else. A user who wants none of those never contacts
  Relay's servers.

## Components

| Component | Where it runs | What it is |
|---|---|---|
| `relay` CLI | user's laptop | Zero-dependency Node. Seals the session, pushes the branch, registers the handoff, waits for a terminal state. `product/cli/` |
| relay-cloud | `poc-ec2` | Accounts, entitlements, devices, nodes, handoff state machine, rendezvous, APNs fanout. SQLite. It can no longer create a machine. `product/cloud/` |
| relayd | the user's own machine | The node daemon: jobs, workspaces (jailed), handoff import, credential install, harness adapters, QR pairing, and its own TLS. `product/relayd/` |
| broker | `relay-router` | Tunnel between the phone and a node. Still needed for a machine behind NAT. `product/broker/` |
| grant gateway | broker host loopback `:8791`; public `gateway.<api-zone>` | Ed25519 grant verify + GET activity proxy. Ingress on the broker host, not poc-ec2. `product/grant-gateway/` |
| web console | not deployed via CodeCommit `relay-cloud` or `ops/deploy-poc` | Vite+React: login, phone QR, `/cli-login`, admin, activity. No machine list and no provisioning page — there is nothing for it to provision. `product/web/` |
| iOS app (Relay) | phone | Pairs by QR, then talks to the node directly with a bearer token over the node's pinned TLS. Sign-in is optional and buys handoff and push. `ios/POCVault/` |

## Connect your own machine

None of this is deployed yet. `relayd` has no installer and no published
package; getting it onto a machine today means copying the repository there and
running it from source.

### The quickstart

1. On a machine you control — a VM, a spare box, anything that runs Node —
   install `relayd` and start it. Set `RELAYD_PUBLIC_HOST` to the hostname or IP
   the phone will reach it on.
2. Run `relayd pair`. It prints a short code and an ANSI QR block. Both are
   single-use and expire after 15 minutes.
3. Scan the QR in the Relay app. The phone imports its client identity, pins the
   machine's CA, stores its bearer token, and starts using the machine. There is
   no account step.
4. From your laptop, run `relay sync-auth` to copy the AI-provider credentials
   you already have onto that machine. Moving credentials is the reason the CLI
   still exists.

Sign in only when you want laptop handoff, push notifications, or `relay login`.

### relayd terminates its own TLS

In direct mode `relayd` used to serve plain HTTP and expect a reverse proxy in
front of it to do TLS and to inject `X-SSL-Client-*` headers. That made "bring
your own VM" a four-step job: install a proxy, get a DNS name, get a publicly
trusted certificate, keep it renewed.

It now serves TLS itself, with a server certificate signed by the node's own CA
— the same CA that signs the device certificates. No proxy, no DNS, no ACME.
`RELAYD_PUBLIC_HOST` goes into the certificate's SAN list, IP SANs included, so
an address like `https://203.0.113.10:8080` works with no name at all. Set
`RELAYD_DIRECT_TLS=0` to opt out and keep the old plain-HTTP-behind-a-proxy
arrangement.

The tunneled mode through the broker is unchanged and still the answer for a
machine behind NAT.

### What the QR carries

`relayd pair` renders one URL:

```
https://get.openrelay.sh/pair#v=1&n=<nodeId>&m=<nodeName>&t=<token>
                              &p=<base64url(pairEndpointUrl)>
                              &a=<base64url(apiBaseUrl)>
                              &f=<base64url(sha256(node CA SubjectPublicKeyInfo))>
```

Everything after `#` is a URL fragment, so a browser never sends it to a server
and it never lands in an access log. A generic camera app shows a tappable
universal link; the in-app scanner parses the same string and never opens a
browser at all.

`p` is where the phone POSTs to pair. `a` is where it works afterwards —
required, because otherwise the phone knows how to pair but not where to go
next. `RELAYD_PAIR_LINK_BASE` overrides the link origin and
`RELAYD_PAIR_API_ADVERTISE` overrides the advertised `a`, for the case where the
address the node sees itself on is not the address the phone reaches.

### Why the QR carries a certificate fingerprint

A machine that signs its own certificate has a bootstrap problem: the phone's
very first request is the pairing POST, and it arrives at a certificate the
phone has no reason to trust. Both obvious answers are wrong.

- **Serve the pairing endpoint over plain HTTP.** The pairing token travels
  inside that request. A passive listener on the same network reads it; an
  active one redeems it first. Single-use protects the honest party from replay,
  not from losing a race.
- **Disable TLS validation for the first call.** That ships an app that will
  talk to anything, and the habit outlives the excuse that introduced it.

The QR is already an authenticated out-of-band channel — it came off the user's
own terminal, and a human is looking at both screens — so it is the right place
to carry the pin. `f` is `sha256` over the node CA's SubjectPublicKeyInfo. The
phone requires the pairing connection's chain to terminate in a CA whose SPKI
hash equals `f`, and after pairing it checks that the `caPem` it was handed
hashes to the same value. Pinning the CA rather than the leaf lets the node
rotate its server certificate without invalidating a code that is already
printed.

This is the SSH host-key-in-the-QR pattern: trust established once, out of band,
by a person who can see both ends.

### The pairing exchange

```
machine (relayd)                                   phone
  │                                                  │
  │ relayd pair                                      │
  │  mint secret, print QR (n, m, t, p, a, f)        │
  ├──────────── QR on screen, scanned ──────────────►│
  │                                                  │  pin CA by f
  │◄── POST /v1/pair {v:2, code, blob, tag} ─────────┤  blob = {mint:"p12", …}
  │  verify tag with macKey derived from the secret  │
  │  mint device cert + p12, encrypted with p12pass  │
  ├──── {deviceId, p12, caPem, apiBaseUrl, …} ──────►│  check caPem hashes to f
  │  store sha256(deviceTok) only                    │  import p12, store bearer
  │                                                  │
  │◄──── GET <apiBaseUrl>/… Authorization: Bearer ───┤
```

Both sides derive every secret from the pairing token; nothing crosses that one
side could not compute. The node keeps only `sha256(deviceTok)`, so a copy of
its database does not yield a working credential. The code is consumed
atomically, so two concurrent redemptions cannot both succeed.

## AWS — two accounts: compute in one, DNS split across both

The split is **not** prod/staging. It is *machines here, several domains there*,
and the two cross over — which is easy to get backwards.

| | Account `507121383669` (`default`) | Account `992203938018` (`cut-personal`) |
|---|---|---|
| Holds | every Relay EC2 instance, both S3 buckets | the product domain and `conformal.live` |
| Route 53 | `ai-rocket-experiments.com` (Z080645839I5BO3TEQ366), `rocketizer.ai`, plus private zones | `openrelay.sh`, `conformal.live` (Z01646542WQQGABIKJZV5), `cutcompanion.xyz` |
| Serves | `relay.ai-rocket-experiments.com` → `poc-ec2` | `www`/`get.openrelay.sh` → CloudFront, with ACM validation records |

The crossover that makes this confusing: **`conformal.live`'s zone lives in the
cut account, but three of its records point at a machine in the Relay account.**

```
conformal.live zone            (cut, 992203938018)
├── conformal.live         ──► 13.206.15.163  cutcompanion-backend   (cut account)
├── dcmshriram, pnb        ──► 13.206.15.163  cutcompanion-backend   (cut account)
└── api|codex|vault.pocs   ──► 3.111.143.88   pariksj-dev            (RELAY account)

ai-rocket-experiments.com zone (Relay, 507121383669)
└── relay                  ──► 43.204.94.3    poc-ec2                (RELAY account)
```

So "who owns conformal.live" and "what is it pointing at" have different
answers, and an earlier revision of the EC2 handoff doc asserted the first
while I checked only the second. The zone is not in the Relay account; the
`pocs.*` target is.

**`openrelay.sh` is the product domain**, and it is in the cut account. It
already carries ACM validation records and a CloudFront distribution for
`www`, plus a `get` subdomain — which is what `STATUS.md`'s "product domain,
`api.`, `get.`, `*.tun.`, `www.`" item is about. Nothing in `product/` deploys
to it yet; the live control plane is still on
`relay.ai-rocket-experiments.com`. Any cutover has to account for the cert and
DNS living in a different account from the instance.

`cutcompanion-backend` (`i-06e721ea98a675006`, in the cut account) is a
different product. No Relay component depends on it.

### Relay compute — all in `507121383669`, region `ap-south-1`

| Instance | Role |
|---|---|
| `poc-ec2` · `i-0ce97c38c7fd74825` · t3.large · 43.204.94.3 | **Control plane.** nginx terminates public TLS for `relay.ai-rocket-experiments.com` and proxies to `127.0.0.1:8790`. SQLite at `/var/lib/relay-cloud/`, backed up to S3 on a timer |
| `rocketizer-cubesandbox` · `i-077519030563ae4a8` · m6i.2xlarge · no public IP | **Idle.** Was the sandbox host: Cube (E2B-API-compatible) microVMs, the local image registry on `:5000`, the Cube API on `:3000`. Nothing calls it. It is still running and still billing at m6i.2xlarge; terminating it is the owner's decision and this change did not do it |
| `relay-router` · `i-0c23c6701070f68b3` · m4.large | **Broker.** Phone ⇄ node tunnel |
| `pariksj-dev` · `i-0364bb0f31f506e7c` · m4.large · 3.111.143.88 | Owner's personal dev box. **Not part of the product** — but it serves `codex.pocs.conformal.live`, which was the checked-in iOS default until 2026-08-13 |

Supporting resources, same account: Route 53 zone `ai-rocket-experiments.com`;
`relay-cloud-cicd-507121383669-ap-south-1` (release artifacts);
`relay-poc-backups-507121383669-ap-south-1` (SQLite backups, versioned,
block-public-access, SSE-S3).

No Relay *compute* runs in the cut account, and nothing in `product/` deploys
there — but it is not irrelevant to Relay either: it holds `openrelay.sh`, the
product domain, and the `conformal.live` zone whose `pocs.*` records point back
at a Relay-account machine. Credentials for both are needed to reason about
DNS; only the default profile is needed to deploy.

Access to both hosts is **AWS SSM only** — no inbound SSH, and the control
plane's listener is loopback-bound.

## How a handoff actually flows

```
laptop                    GitHub          control plane        user's machine        phone
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
  │◄─ polls to ready/failed ─┼──────────────────┤                     │◄─ direct fetch ─┤
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

There is no image build any more. `product/trial/` and the Cube template
pipeline it drove were deleted on 2026-09-08. The Cube template that pipeline
produced is unused, and nothing replaces it: a machine gets `relayd` because
its owner put it there.

`relayd` has no deployment path of its own. It is not packaged, not published,
and not installed by any script in this repository — the user copies the source
onto their machine and runs it. An installer is the obvious next piece of work
and does not exist.

## Known gaps

- **`DEVICE_LOGIN_URL` must still be set on the control-plane host.** The
  `/cli-login` page now exists in `product/web`. Until the host env is
  `https://<app-origin>/cli-login`, `relay login` keeps the `config.js`
  placeholder `https://relay.example/cli-login` and the QR encodes the same
  dead domain.
- **`sync-auth` produces no visible change.** The model catalog is built once
  at daemon boot from env vars and never inspects credentials, so a successful
  sync has nothing to show in the app. Credentials do reach jobs.
- **`relayd` is not packaged.** No installer, no release artifact, no systemd
  unit shipped. Every BYO install is manual, which makes the quickstart above
  aspirational until that is fixed.
- **The waitlist is vestigial.** `POST /v1/waitlist` still accepts rows and
  nothing reads them; no capacity is gated on anything any more.
- **StoreKit is retained but unwired.** `app-store.js`, the `apple_subscriptions`
  table, `/v1/subscriptions/apple/*` and `RelaySubscriptionStore.swift` are all
  still in the tree and no UI references them. Nothing can be purchased. They
  are kept so the App Store Connect items stay valid, not because they do
  anything.
- **No Notification Service Extension.** `mutable-content` is set so one could
  take over the banner later and move the names back out of the payload.
- **No `relay logout`.** Nothing unbinds a CLI from an account.
