# Admin Console — Design

> Status: approved by owner 2026-08-14 (brainstorming session).
> Scope: Better Auth admin role for the operator; web-console Admin page
> to list accounts, inspect sandbox/trial status, upgrade a trial to a
> permanent hosted machine plus a BYO slot, and run Better Auth user ops
> (ban, impersonate, set-role).
> Extends `docs/superpowers/specs/2026-08-13-web-auth-console-design.md`
> and `revamp/07-trial-sandbox-plan.md`.
> Visual language: `docs/superpowers/specs/2026-08-11-editorial-ember-design.md`.
> Hostnames genericized.

## 1. What this is

Relay does not sell tokens. A trial is a Cube sandbox with a TTL; a
"full" account is a hosted machine that no longer expires, plus the
right to connect a computer of their own (`nodes.max`).

Today the only ops surface is `GET /v1/admin/nodes` behind
`ADMIN_TOKEN`. There is no login, no account list, no way to stop a
trial clock, and the iPhone keeps showing **Trial · N days left** for
as long as `GET /v1/trial-nodes/current` returns `creating`/`ready`.

This design adds Better Auth's **admin plugin**, makes
`parikshit.joon@gmail.com` the admin, and puts an **Admin** section on
the existing web console.

## 2. Decisions fixed during brainstorming

| Question | Decision |
|---|---|
| Upgrade means | **Keep the hosted sandbox and allow a BYO computer.** |
| After upgrade | Node is a normal machine: **no Trial badge, no TTL, no countdown.** |
| Auth | Better Auth **admin plugin**. Built-in `admin` role (full control). No custom `superadmin` access-control role. |
| Who is admin | The existing Relay account `parikshit.joon@gmail.com`, same Apple/password sign-in. |
| UI | **Admin section on the existing web console**, not a separate origin and not APIs-only. |
| v1 actions | Account list + trial/sandbox status + **Upgrade** + **Unlink**, plus Better Auth **ban / impersonate / set-role**. |
| Impersonate other admins | **No** in v1. Do not grant `impersonate-admins`. |
| `ADMIN_TOKEN` | **Keep** for `GET /v1/admin/nodes` scripts. New Admin UI uses a Better Auth admin session, not the token. |

## 3. Architecture

```
  Web console /admin          relay-cloud
        │                           │
        │  /api/auth/admin/* ──────▶│  Better Auth admin plugin
        │     list, ban,            │  (role, ban, impersonate)
        │     impersonate, set-role │
        │                           │
        │  GET  /v1/admin/accounts ─▶│  accounts + trial + node +
        │  POST /v1/admin/accounts  │  entitlements (admin session)
        │       /:id/upgrade ───────▶│  kind, trial state, nodes.max
```

Better Auth remains the source of truth for **who is an admin**. Relay
does not invent a second role table. Relay-specific work (sandboxes,
upgrade) lives on `/v1/admin/*` and checks the same admin session.

### 3.1 Admin plugin

In `createRelayBetterAuth`, add `admin()` next to `username()` and
`bearer()`. Existing `getMigrations()` already runs on boot; the plugin
adds `role`, ban fields, and related columns on `user`.

Default roles only: `admin` and `user`. `defaultRole` stays `user`.
`adminRoles` stays the default `["admin"]`.

### 3.2 Pinning the operator

Config: `RELAY_ADMIN_EMAILS` (comma-separated, normalized with
`normalizeEmail`). Production value is `parikshit.joon@gmail.com`.

A caller is an admin if **either**:

- Better Auth `user.role` includes `admin`, or
- the session email is in `RELAY_ADMIN_EMAILS`

On authenticate (and on boot once migrations have run), if the email is
in `RELAY_ADMIN_EMAILS` and the Better Auth user exists, set
`role = admin`. That way the first sign-in after deploy works without a
restart, and `adminUserIds` is not the only gate.

**Make user cannot demote an env-pinned email.** `set-role` to `user`
on `parikshit.joon@gmail.com` still leaves them admin via the email
list. Admins granted only through **Make admin** can be demoted.

Tests pass a different email via env. Do not hard-code the production
address in route handlers.

### 3.3 `requireAdmin`

Shared helper used by the new Relay admin routes:

- no session → `401 { "error": "unauthorized" }`
- session but not admin → `403 { "error": "forbidden" }`
- admin → continue

Do not use `404` for a logged-in non-admin. CSRF/Origin rules are
unchanged: the web origin is already trusted.

## 4. Upgrade

One POST, one SQLite transaction, idempotent.

Eligible: the account has a trial in `creating` or `ready` **and** a
node id (a live hosted machine). `failed` / `expired` / `destroyed` /
`NONE` are not eligible.

### 4.1 Writes (same transaction)

1. `nodes.kind`: `trial` → `byo` for that node. It now counts toward
   `nodes.max`.
2. `nodes.name`: if it is still the default `"Trial machine"`, rename
   to `"Machine"`.
3. `trial_nodes.state` → `upgraded`. `sandbox_id` and `node_id` stay.
   `expires_at` is left as historical; the reaper never reads this
   state.
4. `nodes.max` → `max(current, 2)` so they can keep the hosted box
   (now a `byo`) and register one computer. If the entitlement is
   already `>= 2`, leave it.

Never call `killSandbox`. Never delete the trial row (`account_id` is
`UNIQUE`; deleting it would look like "no trial ever" and allow a
second provision).

### 4.2 HTTP

`POST /v1/admin/accounts/:id/upgrade` (admin session)

- `200 { "ok": true, "account": <same shape as list row> }` on success
  and on a no-op retry (already `upgraded`, `kind: byo`,
  `nodes.max >= 2`).
- `404 { "error": "unknown_account" }` if the id is missing. Same body
  for a foreign-looking id — do not distinguish.
- `409 { "error": "nothing_to_upgrade" }` if there is no live hosted
  machine to convert.

### 4.3 Reaper and capacity

`listTrialsDue` and `countActiveTrials` already filter
`state IN ('creating','ready')`. `upgraded` is skipped: the sandbox
is not killed at TTL, and it does not occupy a trial slot.

`listTrialsPastGrace` only reads `expired`. Unchanged.

### 4.4 Existing trial routes after upgrade

| Route | After `upgraded` |
|---|---|
| `GET /v1/trial-nodes/current` | **200** with `state: "upgraded"`. Must **not** 404 `no_trial` — iOS `applyRefresh(.noTrial)` calls `clear()` and drops `activeNodeURL`. |
| `POST /v1/trial-nodes` | **409 `trial_already_used`**. They already have a hosted machine. |
| `DELETE /v1/trial-nodes/current` | **409 `trial_not_deletable`**. Trial-delete must not kill a gifted machine. Tear-down is `DELETE /v1/nodes/:id` (see §4.5). |

`RelayTrialNode.State` on iOS gains `upgraded`. Unknown future states
must not crash decode; if the decoder is strict today, add `upgraded`
explicitly and keep the test fixture in lockstep.

### 4.5 Deleting an upgraded machine

`DELETE /v1/nodes/:id` today drops the node row and leaves the Cube
sandbox running. After this work, if that node is still referenced by
a `trial_nodes` row with a `sandbox_id` (including `upgraded`), the
handler must `releaseSandbox` first, then delete the node, then set
the trial to `destroyed`. Otherwise "it's a normal machine" leaks a
microVM.

## 5. Admin HTTP

### 5.1 `GET /v1/admin/accounts`

Admin session. Newest accounts first. Bound the page (`limit` default
50, max 100, `offset` default 0). Each item:

```
{
  id, email, name, role, banned,
  trial: { id, state, nodeId, sandboxId, createdAt, expiresAt } | null,
  nodes: [{ id, kind, name, lastSeen, createdAt }],
  entitlements: [{ feature, value }]
}
```

Do not return pubkeys, enroll tokens, pairing secrets, session tokens,
or sandbox env. `sandboxId` is an ops handle, not user data.

### 5.2 Better Auth admin

The web client uses `adminClient()`. Server plugin endpoints cover
list/ban/impersonate/set-role. Relay does not wrap those in `/v1`.

Impersonation: Better Auth default session duration (1 hour). Chrome
shows **Stop impersonating** whenever the session is impersonated.
v1 does not grant `impersonate-admins`.

### 5.3 `GET /v1/admin/nodes`

Unchanged: `Bearer $ADMIN_TOKEN`, omits pubkeys. The Admin page does
not use this route.

## 6. Web console

Route `/admin`. Nav item **Admin** only when the session is admin.
Any other signed-in user who opens `/admin` is sent to `/machines`.
Signed-out users go to `/login`.

Editorial Ember: serif title, hairline rows, status as small-caps
words, ember only on **Upgrade**. No dots.

Each account row:

- email / name
- trial state word: `CREATING`, `READY`, `UPGRADED`, `EXPIRED`,
  `DESTROYED`, `FAILED`, or `NONE`
- hosted machine id if any
- `nodes.max`
- role and ban state

**Upgrade** is the primary action, disabled unless the row is eligible
(`creating`/`ready` with a node). Confirm copy: “Keep this hosted
machine, drop the trial limit, allow their own computer.”

Text actions on the same row: **Ban**, **Impersonate**, **Make admin**
/ **Make user**, and **Unlink** when the account has a hosted machine —
one the trial row still references (`trial.nodeId`), whatever its state;
never a BYO registration. Unlink kills the sandbox, deletes the node,
and marks the trial `destroyed` (`DELETE
/v1/admin/accounts/:id/machine`; 409 `nothing_to_unlink` otherwise).
Confirm copy: “Unlink deletes this hosted machine and its files.” Do
not add a second table.

After upgrade, Machines already renders `kind !== "trial"` as
**YOUR MACHINE** and must not pass the trial into
`machineStatusWord` for that node (it already keys off `node.kind`).

## 7. iPhone

`TrialStatusBanner` at the root browser is shown only when
`nodeStore.trial` exists and `state` is `creating`, `ready`, or
`expired`. **Not** for `upgraded`, `destroyed`, or `failed`.

`applyRefresh` / `updateTrial`:

- `upgraded` keeps `activeNodeURL` (same as `ready`) and persists the
  row so a relaunch does not resurrect the countdown from a stale
  `ready` blob.
- `no_trial` still `clear()`s, as today.

Account → **Trial machine** (status + delete) is hidden when state is
`upgraded`. Delete stays available for a live trial.

Old builds that do not know `upgraded` may fail to decode the current
trial or keep showing the badge until the next Relay build. The
machine URL keeps working either way. Do not 404 current to "fix" old
clients.

## 8. Errors

| Case | Response |
|---|---|
| No session on `/v1/admin/*` | `401 unauthorized` |
| Signed in, not admin | `403 forbidden` |
| Unknown account id | `404 unknown_account` |
| Upgrade with no live machine | `409 nothing_to_upgrade` |
| Retry of a completed upgrade | `200 ok` |
| `DELETE` current on `upgraded` | `409 trial_not_deletable` |
| Better Auth admin as a user | plugin `403` / forbidden |

Partial upgrade is not observable: kind, trial state, and entitlement
commit together.

## 9. Testing

Cloud:

- Migrations leave a `role` column; a seeded admin email is admin; a
  normal user is not.
- `GET /v1/admin/accounts` is 401 / 403 / 200 as in §8.
- Upgrade: `kind` becomes `byo`, state `upgraded`, `nodes.max` is at
  least 2, `sandbox_id` unchanged; Cube kill is not called.
- Second upgrade is 200 and does not change rows.
- `nothing_to_upgrade` when there is no live machine.
- Reaper does not expire or destroy `upgraded` rows whose
  `expires_at` is in the past.
- `GET /v1/trial-nodes/current` returns `upgraded`, not `no_trial`.
- `POST /v1/trial-nodes` 409s `trial_already_used`.
- `DELETE /v1/trial-nodes/current` 409s `trial_not_deletable`.
- `DELETE /v1/nodes/:id` on an upgraded node kills the sandbox (fake
  provisioner) and sets trial `destroyed`.
- Better Auth: list/ban/set-role/impersonate succeed as admin and
  fail as a user; impersonating an admin fails.

iOS:

- `upgraded` hides the capsule and Account → Trial machine.
- `applyRefresh` of `upgraded` keeps `activeNodeURL`.
- `no_trial` still clears.

Web:

- `/admin` renders for an admin session and redirects others.
- Upgrade confirm POSTs `/v1/admin/accounts/:id/upgrade`.
- Machines shows **YOUR MACHINE** after kind flips.

## 10. Deploy

Cloud schema: Better Auth admin columns via existing boot migrations;
`upgraded` is a new `trial_nodes.state` value (TEXT, no CHECK). Online
SQLite backup, then `product/cloud/deploy/cicd-deploy.sh`. Set
`RELAY_ADMIN_EMAILS` on the host. After deploy: `/healthz` 200,
unauthenticated `/v1/admin/accounts` 401, operator sign-in can open
`/admin`.

iOS change ships in the next Relay build. Web console deploys with
the Admin route. An old phone build may still show the badge; the
hosted machine stays up.

## 11. Non-goals

- Custom Better Auth access-control roles (`superadmin`, etc.).
- Impersonating other admins.
- Billing, Stripe, or a customer-facing "subscription" SKU.
- A second concurrent trial sandbox per account.
- Changing Cube/E2B itself; we only stop the Relay reaper.
- Replacing `ADMIN_TOKEN` for `GET /v1/admin/nodes`.
- Admin on the iPhone app.
- Waitlist or APNs management in v1 Admin.
- Silently converting expired/destroyed trials; those stay
  `nothing_to_upgrade` until there is a live machine.
