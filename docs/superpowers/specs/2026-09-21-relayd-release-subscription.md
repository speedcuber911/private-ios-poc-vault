# Relay — relayd release subscription and self-update

> Spec date 2026-09-21. Today every `relayd` on every machine is updated by
> hand. This makes the control plane the one place a release is announced, and
> gives each node a subscription to that announcement plus the ability to apply
> it itself: signed artifact, staged install, health check, rollback. The phone
> is not involved and the control plane never gains the ability to run code on
> a machine.

## The one-paragraph version

The operator publishes a signed `relayd` tarball to the control plane, which
hosts it and records "stable is now version X". Every node already holds a long-poll
open to the control plane; that poll's response grows one field describing the
current release for the node's channel. A node that sees a version newer than
its own downloads the artifact, verifies a detached Ed25519 signature against a
public key baked in at install time, stages it beside the running copy, waits
until it is idle, flips a symlink, restarts, and checks its own health — rolling
back if that check fails. Nodes also start reporting the version they are
running, so "which machines are stale" becomes a question the fleet can answer.

## Why this, and why now

Three facts about the current code make the manual updating inevitable:

- **A node does not know what version it is.** `product/relayd/package.json:3`
  has said `0.1.0` since the beginning and is not derived from anything.
  `GET /healthz` and `GET /v1/codex/health` report queue depth and active jobs
  but no build identity (`product/relayd/src/server.mjs:499-508`). `GET /v1/meta`
  is documented with a `version` field (`product/relayd/API.md:1427-1437`) and is
  not implemented.
- **The control plane has a column for it that nobody fills.** `POST /v1/nodes`
  accepts an optional `version` and `registry.touchNode` can store it
  (`product/cloud/src/server.js:1223-1230`, `registry.js:681-690`), and
  `GET /v1/admin/nodes` already returns it (`server.js:740-748`). iOS never
  sends it (`RelayAuthClient.swift:247-252`) and neither does `relayd`.
- **There is no trigger.** `product/relayd/dist/install.sh` already performs a
  correct in-place upgrade — copies `src/`, `bin/`, `package.json` into
  `/opt/relayd/app` and restarts the unit (`install.sh:236-247`, `360-369`) —
  but nothing ever tells a machine that it should.

So this is mostly wiring. The two halves exist and are not connected.

## The model, stated precisely

It is publish/subscribe in the sense that matters — one announcement, many
independent observers, publisher unaware of who acts on it — but **the node
pulls the artifact and decides when to apply it.** It cannot be push:

- A BYO machine is behind NAT. The control plane holds no inbound path to it,
  which is the entire reason `tunnel.mjs` exists.
- The control plane holds no credential that authorises code execution on a
  node, and this spec must not create one. See *Trust* below.

The shape is `apt`/`unattended-upgrades`, not a deployment system: announce a
fact, let each subscriber reconcile against it.

### The announcement rides the poll that already exists

`relayd` parks on `GET /v1/node/handoffs?wait=N`, Ed25519 request-signed
(`cloudclient.mjs:350-367`, `product/cloud/src/nodeauth.js:26-30`). That
response already carries two different kinds of payload:

- **Leased work**: `handoffs` and `notices`, each a per-node row with a lease
  token and an ack, because each must be delivered exactly once
  (`server.js:793-810`).
- **Ambient state**: `computerAccess`, which is simply the current answer to a
  question, present on every response, with no row, lease or ack
  (`server.js:810-813`).

**A release announcement is ambient state, not leased work.** "Stable is version
X" is idempotent, identical for every node on the channel, and re-reading it
costs nothing. Fanning it out as one leased notice row per node would create a
delivery queue for a fact, and would drag a new notice kind through
`actionableNotices` — which today requires `pairingId` and `secret` on every
notice and skips anything else (`cloudclient.mjs:324-329`). So:

**The poll response grows one top-level `release` object, alongside
`computerAccess`. No new route, no new rows, no leases, no acks, no new
transport, and no change to the notices contract.**

A node parked on a poll will not be woken early by a new release —
`waitForHandoff` is only signalled for pending handoffs and notices
(`server.js:770-780`) — so a node learns at the end of its current wait window,
bounded by `config.handoffPollMaxWaitSec`. For updates that is fine and it is not
worth complicating the waiter.

### Normative wire additions

Added to the `200` body of `GET /v1/node/handoffs`:

```json
{
  "release": {
    "channel": "stable",
    "version": "0.2.0",
    "url": "https://<release-host>/relayd/0.2.0/relayd-0.2.0.tar.gz",
    "sha256": "<hex>",
    "sigAlg": "ed25519",
    "sig": "<base64url detached signature over the sha256 digest bytes>",
    "minVersion": "0.1.0",
    "notes": "<optional short human line>"
  }
}
```

- `release` is **absent**, not null, when no release is published for the
  channel. An older `relayd` ignores an unknown field, so this is backward
  compatible in both directions.
- `minVersion` is the oldest version that may update *directly* to this one. A
  node below it must step through an intermediate release. This is the escape
  hatch for a migration that cannot be skipped.
- `sig` covers the digest, not the URL, so the artifact can be re-hosted or
  moved behind a CDN without re-signing.

Added to `POST /v1/node/heartbeat`, whose body is currently the literal `{}`
(`cloudclient.mjs:431-442`):

```json
{ "version": "0.1.0", "channel": "stable", "pendingVersion": null }
```

The cloud stores these on the node row via `touchNode`. `pendingVersion` is set
while a node has staged an update it has not yet applied, which is what makes a
node stuck mid-update visible rather than silent.

### Version identity

`relayd` gets a real build identity, written at package time, not hand-edited:

- `product/relayd/src/version.mjs` exports `{ version, commit, builtAt }`,
  generated by the packaging step from the git SHA and the tag.
- `GET /healthz` and `GET /v1/codex/health` report `version`. This is also what
  finally lets the iOS app stop guessing: `RelayMachineMonitorView` already has
  copy for "this machine's Relay service is too old to report usage"
  (`unsupportedInfo`) that it currently infers from a `404`.
- `relayd status` prints it, and `relayd update --check` prints the current
  channel release next to it.

## Trust — the one hard decision

This is the first mechanism in Relay by which something outside the user's
machine can cause new code to run on it. `AGENTS.md` and the BYO spec both rest
on the claim that the control plane is *not on the path to using the product*;
an update channel is exactly the kind of thing that quietly makes that claim
false. The design therefore has to answer: **if the control plane host were
compromised, what could it do to every paired machine?**

The answer depends entirely on who holds the signing key.

**Chosen: the signing key is offline and is not present on the control plane
host.** Releases are signed where they are built, by a key held outside the
cloud deployment; `install.sh` bakes the corresponding *public* key into
`/opt/relayd/` at install time, and `relayd` verifies every artifact against it
before unpacking. Under this arrangement a compromised control plane can
withhold an update, announce an old version, or point at a mirror — denial and
delay — but it **cannot author code that a node will execute**, because it
cannot produce a valid signature. Rollback and version-pinning attacks are
bounded by `minVersion` plus the node's refusal to move backwards (below).

The alternative — the cloud signs releases — is meaningfully simpler and would
let a release be cut without touching an offline key, but it makes compromise of
one EC2 host equivalent to remote code execution on every user machine,
including Parikshit's. That trade is not worth it for a project whose stated
perimeter is direct phone-to-machine trust.

Consequences that are part of this spec, not optional hardening:

- `relayd` **refuses to downgrade**. An announced version lower than the running
  one is ignored and logged. Otherwise "announce 0.1.0 forever" is a way to walk
  a fleet back to a version with a known hole.
- A cloud outage, a `4xx`, or an unparseable `release` field must be inert. A
  paired machine keeps serving the phone exactly as it does today; the update
  path is the only thing that stalls.
- Auto-apply is controlled per machine by `RELAYD_AUTO_UPDATE` in
  `/etc/relayd/relayd.env`. With it off, the node still reports its version and
  still learns about releases — `relayd update` applies one when the operator
  runs it.

  **Decision taken by the owner on 2026-09-21: auto-apply defaults to ON**
  (`RELAYD_AUTO_UPDATE=0` opts out), because the point of the exercise is that
  one command on the laptop updates every machine without anyone logging in. The
  signature check, the downgrade refusal and the drain-plus-rollback cycle are
  what make that safe; the opt-in default was belt-and-braces on top of them.
- Every check, download, verification result, apply and rollback is an audit
  line (`audit.mjs`), and a successful apply posts a node event so the phone can
  say what happened.

## Applying an update

Mirroring what `product/cloud/deploy/install.sh:69-101,156-165` already does for
the control plane, because that shape is proven in this repo:

1. **Decide.** Announced version parses, is greater than running, running is at
   or above `minVersion`, channel matches, not pinned. Otherwise stop.
2. **Download** to a temp path. Verify `sha256`, then verify `sig` over the
   digest against the baked-in public key. A failure here deletes the download
   and is an audit line — never a partial install.
3. **Stage** into `/opt/relayd/releases/<version>/`, immutable, beside the
   running copy. Set `pendingVersion` for the next heartbeat.
4. **Drain.** Do not restart while work is live. `relayd` holds job runs, SSE
   streams and terminal sessions, so a restart is visible on the phone mid-
   sentence. Wait for zero active jobs and zero attached terminals, bounded by a
   window; if the window expires, stay staged and try again later. An explicit
   `relayd update --now` may override.
5. **Flip** the `current` symlink and `systemctl restart relayd`.
6. **Verify** by polling the node's own `/healthz` for a bounded period and
   checking that the reported version is the new one.
7. **Roll back** on failure: point `current` back, restart, audit the failure,
   and mark the version as poisoned so the node does not immediately retry the
   same artifact in a loop.

Steps 3, 5, 6 and 7 are the part `dist/install.sh` does not do today — it copies
over the live directory, so there is nothing to roll back to. Introducing the
`releases/<version>` + `current` layout is a prerequisite, and `install.sh`
should adopt it for fresh installs too.

## Rollout control

The point of channels here is concrete: the two machines in play should not move
together. `pariksj-dev` runs the live direct-subscription providers; that is not
the machine to discover a bad release on.

- Each node has a channel — `stable` or `beta` — set in `relayd.env` and
  reported on heartbeat. The announcement is per channel.
- `relayd update --pin <version>` holds a machine where it is, regardless of
  announcements, until unpinned.
- The control plane stores the published version per channel and nothing else
  about rollout. Percentage rollouts, cohorts and staged windows are explicitly
  out of scope; two channels and a pin are enough for a fleet of this size, and
  anything cleverer belongs in a later spec with a real reason.

## Failure modes this must survive

| Situation | Required behaviour |
| --- | --- |
| Control plane unreachable | Node serves the phone normally; no update activity |
| `release` malformed or unknown fields | Ignored, logged; poll continues to work for handoffs |
| Signature invalid | Artifact deleted, audit line, no install, no retry loop on the same digest |
| Digest mismatch | Same as invalid signature |
| Announced version older than running | Ignored and logged (downgrade refusal) |
| Node below `minVersion` | No direct update; audit line naming the required intermediate |
| Jobs or terminals active | Staged, not applied; retried after the drain window |
| New build fails health check | Automatic rollback to the previous release; node stays usable |
| Node offline for weeks | Catches up on its next poll; nothing queued or expired, because the announcement is state and not a message |

## Build order

Each slice is useful alone and shippable alone.

1. **Version identity and reporting.** `version.mjs`, health routes, `relayd
   status`, `version`/`channel` on the heartbeat, stored by the cloud. After
   this, staleness is a question with an answer — which is the thing that makes
   today's manual updating unavoidable. Nothing auto-updates yet.
2. **Release layout.** `releases/<version>` + `current` symlink in
   `dist/install.sh`, plus `relayd update <tarball>` applying a local file with
   the full stage/drain/flip/verify/rollback cycle. Testable with no cloud at
   all.
3. **Publish and announce.** Packaging step that builds and signs the tarball,
   artifact upload and hosting on the control plane, published version per
   channel, `release` on the poll response.
4. **Subscribe and apply.** The node acts on the announcement, behind
   `RELAYD_AUTO_UPDATE`. Point one machine at `beta` first.
5. **Surface it.** Machine section in iOS Settings shows the running version and
   "update available"; a node event when an update lands.

## Non-goals

- No update path for the iOS app (App Store) or the control plane (it already
  has CI/CD).
- No phone-initiated update. The phone may *show* state; it does not trigger
  installs. Adding that would put the update path behind the wake token, which
  is a weaker credential than the operator's shell on the machine.
- No new long-lived connection, no WebSocket, no MQTT broker. The existing
  long-poll is the subscription.
- No percentage or cohort rollout.
- No change to the pairing contract, the notices contract, or any wire format
  frozen in the BYO spec.

## Publishing, from the operator's side

`ops/release-relayd` is the whole release. It builds the tarball from
`product/relayd/`, signs the digest with the Ed25519 key at
`~/.poc-vault/secrets/signing/relayd-ed25519.key` (same accepted key formats as
`ops/sign-manifest.py`), `POST`s the bytes to `/v1/admin/relayd-artifact`,
`POST`s the descriptor to `/v1/admin/relayd-release` using the URL the upload
returned, then watches `/v1/admin/nodes` until every node on the channel reports
the new version.

It never contacts a machine, and it does not touch S3.

**Decision taken by the owner on 2026-09-22: the control plane hosts the
artifact.** S3 with a public base URL was the original sketch, on the grounds
that the publish step should stay a pure API call rather than needing a shell on
`poc-ec2`. Uploading to the control plane over HTTPS satisfies that just as well,
and removes a bucket policy, a second set of AWS credentials, and a public
bucket from the release path. The admin token is now the only credential besides
the signing key. This costs nothing in trust: the control plane still cannot
sign, so hosting the bytes gives it no power it did not already have.

`--local-only` builds and signs without uploading or announcing, which is the
safe dry run.

The artifact is **reproducible**: sorted tar members, a fixed mtime in both the
entries and the gzip header, and a `builtAt` taken from the commit date rather
than the clock. So anyone holding the commit can rebuild and confirm the digest
that was signed, which is most of the value of signing in the first place.

Configuration read from `~/.poc-vault/secrets/config.env`: `RELAY_CLOUD_URL`
and `RELAY_ADMIN_TOKEN`. That is the whole list.

Uploads are immutable and idempotent: re-uploading byte-identical bytes for a
version succeeds, and different bytes under a version already published are
refused. Reproducible packaging is what makes that a useful rule rather than an
obstacle — a retried publish of the same commit produces the same bytes.

`.cursor/skills/relayd-release/SKILL.md` maps "update relayd on all devices"
onto this command, including the dry run and the rule against reaching into a
machine over SSH.

## Where things ended up

| What | Path |
| --- | --- |
| Build identity, written at package time | `<appDir>/build-info.json`, override `RELAYD_BUILD_INFO_FILE` |
| Release trust anchor | `/opt/relayd/release-pubkey.pem`, override `RELAYD_RELEASE_PUBKEY_FILE`. PEM SPKI or a raw 32-byte key in hex/base64url, which is what `ops/release-relayd --print-public-key` emits |
| Immutable releases and the live one | `/opt/relayd/releases/<version>`, `/opt/relayd/current` |
| Staged version, pin, poisoned digests, last announcement | `$CODEX_DATA_DIR/updates/*.json` — mutable state, kept out of the release directory |
| Hosted artifacts on the control plane | `$RELAY_ARTIFACT_DIR/relayd/<version>/relayd-<version>.tar.gz`, default `/var/lib/relay-cloud/artifacts`, outside the deploy tree so a release does not wipe it. Bounded by `RELAY_ARTIFACT_MAX_BYTES`, default 64 MiB |
| The URL nodes fetch | `<BETTER_AUTH_URL origin>/relayd/<version>/<filename>`, public and unauthenticated. Built from configuration and never from the request's `Host`, because it gets signed into an announcement every machine acts on |

Two limits worth stating: with no supervisor, an apply flips `current`, says so,
and leaves the restart to the operator rather than exiting into an outage; and a
release that cannot boot at all has nothing running inside it to roll itself
back, for which the escape hatch is `relayd update --file <previous-artifact>`.
Covering that properly needs a watchdog outside the flipped tree.

## Open questions for the owner

- Who cuts a release, and does it require a tag? The script defaults the version
  from `product/relayd/package.json` and refuses a dirty `product/relayd` tree
  without `--allow-dirty`, so packaging is already a deliberate act; whether a
  tag is also required is still open.
- Does `pariksj-dev` stay on `stable` and pinned indefinitely, given the live
  provider sessions on it?
