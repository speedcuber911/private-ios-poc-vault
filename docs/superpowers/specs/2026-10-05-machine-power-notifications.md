# Machine power notifications

Status: implementing, 2026-10-05.

## What the owner asked for

A push when the idle Lambda pauses a paired dev machine, and a push when a
machine the user switched on from Relay is actually ready, so neither needs the
app open. Both machines (pariksj-dev for the owner, komal-dev for Komal) are in
scope; each phone hears about the machine it is paired with.

## Decisions (owner, 2026-10-05)

- **Who receives:** phones paired with the machine, subscribed with the
  pairing wake token. No Relay account, matching the power plane. Komal does
  not need to sign in.
- **Which stops notify:** the idle auto-stop, and stops made outside Relay
  (AWS console or CLI). A stop requested through Relay, and the stop inside a
  resize, stay silent.
- **Foreground:** the banner shows even with Relay open. `willPresent` is
  unchanged.

## How it works

The control plane on `poc-ec2` is the stateful observer. It already holds the
power registrations and talks to EC2; it now also remembers what it last saw.

**Watcher.** Every 30 s, one `DescribeInstances` for every registered,
allowlisted instance. The last observed state per node is stored in
`node_power_watch`, so a cloud restart neither re-announces nor forgets.

- First observation of a node: record only.
- Last observation older than 10 minutes (the cloud was down): record only, a
  late banner about an old change is noise.
- Into `stopped` from `running`/`pending`/`stopping`: push `power.stopped`,
  unless a resize is active or a stop was requested through Relay in the last
  10 minutes. The reason is `auto` when the instance carries an
  `AutoStoppedAt` tag from the last 30 minutes (the Lambda writes it right
  after `StopInstances`), else `external`. The push waits for `stopped` rather
  than `stopping`, by which point the Lambda's tag is reliably visible.
- Into `pending`/`running` from a stopped state: mark the node as awaiting
  ready.

**Ready.** relayd re-registers with `POST /v1/power/registration` every time
it starts. A registration for a node that is awaiting ready, or that the
watcher last saw stopped, means Relay itself is up: push `power.ready`. A
start through `POST /v1/power/:id/start` marks the node as awaiting ready
immediately. A relayd restart on a machine that was already running stays
silent. If the machine has been running for 5 minutes with no registration,
push `power.ready` with a "Relay hasn't connected yet" banner instead, so a
broken relayd is not silent.

**Subscription.** `PUT /v1/power/:nodeId/push` with the wake token as bearer
and `{apnsToken, apnsEnvironment}` upserts the phone into
`node_power_devices`. `DELETE` with `{apnsToken}` removes it. At most 10
phones per machine; the oldest is evicted. A registration that changes the
node's wake-token hash (a re-pair) deletes every subscription for that node,
so only phones holding the current token are told anything.

## Invariants

1. A push never reaches a phone that does not hold the machine's current wake
   token (subscribe is wake-token authed; re-pair clears subscribers).
2. One transition, at most one push. State is persisted before the push is
   sent, and the watcher skips nodes whose previous observation is stale.
3. A resize never produces a "stopped" push; it ends with one "ready" push
   naming the new size.
4. APNs `410`/`Unregistered` deletes the subscription row; `BadDeviceToken`
   never does (same rule as `apns.js`).
5. No token is ever logged.

## What reaches Apple

The banner names the machine by its EC2 `Name` tag (control characters
stripped, 40 characters max), falling back to "Your machine". That name was
never in a push before; it is chosen by the machine's owner and says nothing
about work on it. Payload under `relay`: `nodeId`, `type`, `ts`, `seq: 0`,
`jobId: null`, the same shape as every other Relay push.

Banners:

| Event | Title | Body |
|---|---|---|
| auto-stop | `<name> paused` | `Idle for an hour, so it stopped to save cost. Start it from Relay when you need it.` |
| outside Relay | `<name> stopped` | `It was stopped outside Relay.` |
| ready | `<name> is ready` | `Relay is connected.` / `Now running as m8a.xlarge. Relay is connected.` after a resize |
| ready fallback | `<name> is on` | `It's running, but Relay hasn't connected yet.` |

The idle duration in the auto-stop banner comes from the Lambda's
`AutoStopReason` tag (`idle-60min`).

## iOS

- `RelayPushService` registers for APNs when the app is signed in **or** has
  a paired machine, and subscribes the token to that machine's power pushes on
  every launch and whenever a wake credential is stored (idempotent upsert).
  Signed-out users see the iOS notification prompt for the first time.
- `power.*` pushes route to `.machine(nodeID:)`, which opens Settings and the
  machine monitor, like the existing `node.*` pushes.
- Unpairing unsubscribes best-effort before the wake token is discarded.

## Not in scope

- Account-linked delivery for these machines.
- Notifying a stop made through Relay to other phones paired with the same
  machine.
- EventBridge-driven detection; 30-second polling of a handful of instances is
  cheaper than the wiring.
