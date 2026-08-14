# Signed-In Places — Design

> Status: approved by owner 2026-08-14 (brainstorming session).
> Scope: list and revoke every place the account is signed in from the
> iPhone; keep exactly one CLI computer; allow many browsers; keep the
> scanner available so Sign in with iPhone works while a computer is
> already linked. Extends
> `docs/superpowers/specs/2026-08-13-web-auth-console-design.md` §4.2
> and `docs/superpowers/specs/2026-08-12-qr-cli-auth-handoff-design.md`.
> Visual language: `docs/superpowers/specs/2026-08-11-editorial-ember-design.md`.
> Hostnames genericized.

## 1. What this is

The control plane already splits device codes into `client: "cli"` and
`client: "web"`. Approving a browser does not occupy the one CLI
computer slot. The iPhone still treats that slot as the whole world:
once Computers shows a connected Mac, **Link a computer** disappears,
and Sign in with iPhone on the web has nowhere to land.

This design makes the phone the control surface for **signed-in
places**: one computer, many browsers, approve a pending sign-in even
when the computer is already linked, and remove any place. A second
CLI scan is refused until the existing computer is unlinked.

## 2. Decisions fixed during brainstorming

| Question | Decision |
|---|---|
| Product | **Signed-in places on the phone**, not a hidden scanner workaround. |
| CLI computers | **Exactly one.** Scanning another `client: "cli"` code is blocked until Disconnect. Cloud 409 `computer_already_linked` stays. |
| Browsers | **Many.** Each web QR (and each password login from the app origin) is its own row and can be removed independently. |
| This iPhone | **Not a row.** Sign out in Security remains the way to leave this phone. Do not list APNs `/v1/devices` here. |
| Pending codes | **Still require a scan or typed code.** Device codes are unbound until approve, so they cannot appear as a list without scanning. |
| Web console | **No session manager.** Phone is the control surface. Browser Sign out is only this cookie. |
| Cap | **10 live browsers per account.** An 11th sign-in is refused (`429 too_many_browsers`) until one is removed. Do not silently kill the oldest. |

## 3. Architecture

Three stores, one list:

| Place | Store | Session | Revoke |
|---|---|---|---|
| Computer (0 or 1) | `cli_computer_links` | HS256 JWT with `cli` claim | `DELETE /v1/auth/device/link` (existing) |
| Browser (0–10) | new `browser_sessions` sidecar + Better Auth `session` row | cookie | `DELETE /v1/auth/places/browsers/:id` |
| This iPhone | Better Auth bearer or Apple HS256 | current phone token | existing Sign out; not listed |

```
 iPhone Account & Settings          relay-cloud
        │                                 │
        │  GET /v1/auth/places ──────────▶│  computer + browsers
        │  DELETE …/browsers/:id ────────▶│  drop cookie session
        │  DELETE /v1/auth/device/link ──▶│  drop CLI slot + JWT
        │                                 │
        │  Approve a sign-in (always on)  │
        │  inspect / approve ────────────▶│  web: no CLI slot
        │                                 │  cli: 409 if slot taken
```

Do not reuse `/v1/devices`. That table is APNs push registration, not
login.

### 3.1 `browser_sessions`

Relay-owned sidecar. Only these rows appear as browsers. iPhone
sessions and CLI JWTs never get a row.

```
browser_sessions (
  id                      TEXT PRIMARY KEY,  -- public revoke id
  account_id              TEXT NOT NULL,
  better_auth_session_id  TEXT UNIQUE,       -- null until mint completes

  display_name            TEXT,
  platform                TEXT,
  created_at              INTEGER NOT NULL
)
CREATE INDEX idx_browser_sessions_account ON browser_sessions (account_id);
```

`id` is a new opaque id (same random-id style as other registry rows).
Responses never include Better Auth session tokens or cookie values.
`better_auth_session_id` is the Better Auth `session.id`. Revoke does
**not** call Better Auth's revoke API (that keys off the session
**token**, which we do not store). Delete the `session` row by `id`
with a direct SQL `DELETE FROM session WHERE id = ?` on the same
DatabaseSync, then delete the sidecar row, in one transaction.

Write a row when:

1. **Web device-code redemption** — `POST /v1/auth/device/token` with
   `client: "web"` after `mintBetterAuthSessionCookie`. Copy
   `machineName` / `platform` from the device-code record onto
   `display_name` / `platform`.
2. **Password sign-in or sign-up from a trusted web origin** — after
   Better Auth sets a cookie session, if `Origin` is in
   `trustedWebOrigins`, insert a sidecar row. `display_name` from a
   sanitized User-Agent (≤64 chars, control chars stripped);
   `platform` is `web`. iOS `/api/auth` calls do not send that Origin
   and must not get a row.

Listing joins sidecar rows to live Better Auth sessions. Drop (or skip)
sidecar rows whose Better Auth session is missing or expired. Account
delete already wipes registry rows; also delete `browser_sessions` for
that `account_id`.

Cap: live-count and sidecar INSERT share one `BEGIN IMMEDIATE`
transaction on the registry's DatabaseSync (SQLite's single writer
makes that sufficient; a count-then-insert without the lock lets two
sign-ins at 9 rows land 11). **Do not `await` inside that
transaction** — this process shares one DatabaseSync across requests,
so a yield would let another request join the open transaction.
createSession is async (`internalAdapter`), so: (1) BEGIN IMMEDIATE,
count live rows, INSERT a sidecar reservation if count < 10, COMMIT;
(2) mint the Better Auth session; (3) UPDATE the sidecar with
`better_auth_session_id`. If mint fails, DELETE the reservation. The
11th INSERT hits the count under the lock and returns `cap`.
Device-code token returns `429 { "error": "too_many_browsers" }`.
Password web sign-in that would exceed the cap must not leave a
usable cookie: delete the Better Auth session just created and return
the same 429 (Better Auth's own handler may have already set the
cookie — clear it with `Set-Cookie` max-age 0). List and revoke ignore
reservations whose `better_auth_session_id` is still null after a
short grace (treat as not live). `better_auth_session_id` is nullable
until step (3); SQLite UNIQUE still allows multiple nulls.

### 3.2 Existing CLI rules (unchanged, restated)

- Unique index on `cli_computer_links.account_id` remains.
- `inspect` / `approve` of `client: "cli"` (or omitted) return 409
  `computer_already_linked` when a link exists.
- `inspect` / `approve` of `client: "web"` succeed while a CLI link
  exists.
- Disconnect revokes the CLI JWT and frees the slot. Browsers are
  untouched. Phone session is untouched.

### 3.3 iOS

Account & Settings **Computers** becomes **Signed in**.

Always-visible **Approve a sign-in** opens the existing scanner sheet
(retitled). The scanner is not gated on an empty computer slot. One
Form section has one footer; use the combined footer in §5.

`DeviceCodeInspectResult` includes `client: "cli" | "web"`. Confirm
copy and success copy branch on it. 409 on a CLI code still maps to
the existing already-linked message: disconnect the computer first.

`GET /v1/auth/places` loads the list. Pull-to-refresh reloads it.
Connecting-computer poll stays as today.

Visual language stays Editorial Ember: serif names, sans controls,
status as a word (`CONNECTED` / `CONNECTING`), never a colored dot.

### 3.4 Web

No new pages. Sign in with iPhone is unchanged (`client: "web"` QR).
If poll returns `too_many_browsers`, show: “This account already has
10 signed-in browsers. Remove one from the Relay app, then try
again.”

## 4. End-to-end flows

### 4.1 CLI already linked, then Sign in with iPhone

```
 browser                         relay-cloud                    iOS
────────                         ───────────                    ───
POST /device/start {client:web}
show QR, poll token
                                              Approve a sign-in
                               inspect ◀──── client=web (200, even
                                             if CLI slot is taken)
                               approve ◀──── no cli_computer_links write
poll Set-Cookie
                               places  ◀──── computer + new browser row
```

### 4.2 Second CLI while one is linked

```
 CLI `relay login`               relay-cloud                    iOS
──────────────────               ───────────                    ───
POST /device/start {client:cli}
show QR
                               inspect ◀──── client=cli
                               409 computer_already_linked
                                             failed: disconnect the
                                             existing computer first
```

Approve of that CLI code is also 409. Unlink, then scan again.

### 4.3 Remove a browser

Phone taps Remove on a browser row → confirm →
`DELETE /v1/auth/places/browsers/:id`. That cookie stops working.
Other browsers and the CLI stay. The row disappears on refresh.

### 4.4 Disconnect the computer

Existing confirmation dialog. CLI access ends. Browser rows stay.
Approve a sign-in can then accept a new CLI code.

## 5. Screens (iOS)

Account & Settings, section **Signed in**:

| State | UI |
|---|---|
| Loading | “Checking signed-in places…” |
| Computer present | Name, status word, platform, connected time, **Disconnect computer** |
| No computer | No placeholder computer row |
| Each browser | Name (or “Browser” if empty), platform, signed-in time, **Remove** |
| No browsers | No empty-state card; footer copy covers it |
| Always | **Approve a sign-in** |

One footer for the section (SwiftUI Form allows only one):

“Only one computer can be linked at a time — disconnect it before
linking another. Each signed-in browser can use the web console;
Remove signs that browser out. Approve a sign-in scans the QR from
Sign in with iPhone, or from `relay login` when no computer is linked.”

Scanner sheet:

| `client` | Title | Confirm | Primary action | Success |
|---|---|---|---|---|
| `web` | Approve a sign-in | Machine name + “Only continue if you just tapped Sign in with iPhone in this browser.” | Sign in this browser | “This browser is signed in.” |
| `cli` or missing | Link a computer | Existing machine copy + “Only continue if you just ran `relay login` on this computer.” | Link computer | Existing “Finish `relay login`…” |
| CLI 409 | — | — | — | Failed: “A computer is already connected. Disconnect it in Account & Settings before linking another one.” |

Remove browser uses a confirmation dialog: “Remove *name*? That
browser will be signed out.” Destructive **Remove**, **Cancel**.

## 6. API

Existing `GET/DELETE /v1/auth/device/link` stay. iOS may keep calling
them during the transition; the places endpoint is the list source of
truth for the new screen.

| Path | Auth | Contract |
|---|---|---|
| `GET /v1/auth/places` | session | `{ computer, browsers }` |
| `DELETE /v1/auth/places/browsers/:id` | session | `{ ok: true }`. 404 `unknown_browser` if the id is missing, expired, or not this account. Never 404 vs 403 distinction that would leak another account’s ids — unknown and foreign are the same 404. |
| `POST /v1/auth/device/inspect` | session | Unchanged lookup-first rule. Response already includes `client`. |
| `POST /v1/auth/device/approve` | session | Unchanged. CLI 409 when the slot is taken. Web never 409 for that reason. |
| `POST /v1/auth/device/token` | none | Web: mint cookie, write `browser_sessions`, 429 `too_many_browsers` at cap. CLI unchanged. |

`GET /v1/auth/places` body:

```json
{
  "computer": {
    "id": "…",
    "machineName": "pariksj-mac",
    "platform": "macos",
    "status": "connected",
    "connectedAt": 0,
    "createdAt": 0
  },
  "browsers": [
    {
      "id": "…",
      "name": "Safari on Mac",
      "platform": "web",
      "createdAt": 0
    }
  ]
}
```

`computer` is `null` when none. `browsers` is `[]` when none, newest
first. `computer` shape matches today’s `publicCliComputer`. Browser
`name` is `display_name` (may be null; client shows “Browser”).

Unauthenticated → 401. The current phone session is never a browser
row. Deleting a browser does not sign out the caller unless the caller
*is* that browser (then the next cookie request is 401).

## 7. Error handling

- **Second CLI while linked** — inspect and approve 409
  `computer_already_linked`. App copy tells the user to disconnect.
  Do not offer “replace this computer” in this pass.
- **Web QR while linked** — 200 inspect/approve. Never 409.
- **Stale / foreign / reused code** — uniform 404 `unknown_user_code`.
  App: existing stale-code copy. For a web confirm, the stale line
  may say “Sign in with iPhone” instead of `relay login`; one message
  per client, still no distinction among 404 classes.
- **Unknown browser revoke** — 404 `unknown_browser`. App: “That
  browser is already signed out.” Refresh the list.
- **Cap** — 429 `too_many_browsers`. App scanner success path does
  not hit this (cap is on token mint). Web poll shows the 10-browser
  copy.
- **Revoke race** — deleting an already-deleted id is 404, same as
  unknown.
- **Account delete** — drop `browser_sessions` with the other registry
  rows.

## 8. Testing

- **Cloud.** Places list: empty; computer only; browsers only;
  computer plus two browsers; expired Better Auth session omitted.
  Revoke: own browser 200 then cookie 401; foreign/unknown 404;
  revoke does not drop the CLI link; disconnect computer does not
  drop browsers. Direct `session` row delete (not token-keyed revoke
  API). Cap: 10th web token succeeds, 11th 429, no 11th sidecar row;
  two concurrent mints at 9 rows still cannot persist an 11th. Password web origin inserts a sidecar; iOS-style
  `/api/auth` without that Origin does not. Existing device-code
  tests remain: web approve with CLI linked; CLI inspect/approve 409
  when linked.
- **iOS.** Inspect result carries `client`. Web confirm copy vs CLI
  confirm copy. CLI 409 still uses `alreadyLinkedMessage`. Approve a
  sign-in is presented when a computer is already connected. Places
  load maps computer + browsers. Remove calls the browsers DELETE.
- **Web.** Poll `too_many_browsers` surfaces the cap copy. No new
  session-manager UI.

## 9. Non-goals

- A second concurrent CLI computer.
- Listing or remotely signing out other iPhones.
- Showing pending device codes without a scan.
- A web UI to list or revoke sessions.
- Changing QR payload shape or `DEVICE_LOGIN_URL`.
- Replacing `/v1/auth/device/link`.
- Touching APNs `/v1/devices`, pairing, trial, grants, or relayd.
- “Replace this computer” from the CLI 409 screen.

## 10. Deploy

Cloud schema change: online SQLite backup first, then
`product/cloud/deploy/cicd-deploy.sh`. After deploy: `/healthz` 200,
unauthenticated `/v1/account` 401, `GET /v1/auth/places` 401 without
a session. iOS change ships in the next Relay build; an old build
keeps hiding the scanner when a computer is linked and cannot list
browsers. The cloud remains backward compatible for that build
(`device/link` and web approve-while-linked already work).
