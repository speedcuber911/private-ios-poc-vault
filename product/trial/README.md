# Relay Trial Template

A Cube/E2B template for running the Relay agent in a sandboxed, tunneled environment.

## Template Contents

- **Base**: Ubuntu 24.04 with Node 22, curl, git, ripgrep, and dependencies
- **Harness CLIs**: `@openai/codex`, `@anthropic-ai/claude-code`, `@moonshot-ai/kimi-code` (preinstalled, unauthenticated)
- **Runtime User**: Non-root `relay` account
- **Workspaces**: Jail at `/srv/relay-workspaces` with a seeded welcome workspace
- **Init**: `start.sh` (no systemd; runs as PID 1)

## Environment Contract

The sandbox receives the following environment variables, injected by relay-cloud:

**Enrollment** (single-use; see "Secret handling" below for what "cleared" does and does not mean):
- `RELAYD_ENROLL_URL`: enrollment endpoint
- `RELAYD_ENROLL_TOKEN`: enrollment bearer token
- `RELAYD_ENROLL_PAIRING_ID`: sandbox identity (immutable)
- `RELAYD_ENROLL_PAIRING_SECRET`: proof of pairing

**Tunneling** (persistent for daemon lifetime):
- `RELAYD_TUNNEL_HOST`: broker hostname or IP
- `RELAYD_TUNNEL_PORT`: broker port
- `RELAYD_TUNNEL_SUFFIX`: subdomain suffix for workspace URLs

Optional overrides (defaults provided in `start.sh`):
- `CODEX_DATA_DIR`, `RELAYD_IDENTITY_DIR`, `CODEX_WORKSPACE_BROWSE_ROOT`, `CODEX_WORKSPACES`, `CODEX_RUN_HOME`, `RELAYD_STORE`

## Boot Sequence

`start.sh` runs as PID 1 and keeps enrollment and device pairing strictly
independent, because they have very different retry semantics:

1. **Enrollment** (`relayd enroll --no-pair`) — once-only and must succeed.
   The cloud burns the single-use token and flips the trial row to `ready` on
   the first call, so a second attempt can only ever 401; with the row already
   `ready`, `POST /v1/trial-nodes` also 409s, so nothing could issue a
   replacement before the 7-day TTL. `${CODEX_DATA_DIR}/enrolled` is written
   the instant enrollment returns 0 and **before** pairing is attempted.
2. **Device pairing** (`relayd enroll --pair-only`) — best-effort, backgrounded,
   and explicitly *not* part of the boot's success condition. It polls the
   cloud rendezvous for the phone's device blob with a 120 s deadline, and the
   phone typically posts that blob before this sandbox has finished booting, so
   losing that one request is enough to time it out. `${CODEX_DATA_DIR}/paired`
   is written only on success, so a failure simply retries on the next boot.
3. **`exec runuser ... relayd run --mode tunneled`** — reached unconditionally.
   Cube's envd stays root-owned for mounts, while relayd and every provider
   harness run as the non-root `relay` user. A pairing failure never prevents
   the daemon from starting.

To re-run pairing by hand against an already-enrolled, already-running node:

```bash
RELAYD_ENROLL_URL=... RELAYD_ENROLL_PAIRING_ID=... RELAYD_ENROLL_PAIRING_SECRET=... \
  node /opt/relayd/app/bin/relayd enroll --pair-only
```

## Secret handling

`start.sh` unsets `RELAYD_ENROLL_TOKEN`, `RELAYD_ENROLL_PAIRING_ID`, and
`RELAYD_ENROLL_PAIRING_SECRET` before `exec`, which clears them from the relayd
daemon and from every process the daemon spawns (including agent harnesses).

It does **not** clear the sandbox-level environment. E2B/Cube injects `envVars`
at the sandbox level for processes started through envd, so a shell the trial
user opens that way may still see them. Both values are single-use and already
spent by the time the daemon starts — the enroll token is burned server-side
and the pairing slots are put-once — so the residual exposure is a spent
credential, not a live one. Removing it entirely requires the sandbox-level
env to stop carrying them (a control-plane/Cube change), not a script change.

## Unauthenticated Harness CLIs

The harness CLIs are installed globally but **not authenticated**. Users must perform device-code login after sandbox boot to connect their own subscriptions (OpenAI API key, Anthropic API key, etc.). No credentials are baked into the image.

## Egress Expectations

The sandbox requires outbound access to:
- LLM provider endpoints (OpenAI, Anthropic, etc.)
- GitHub and other VCS hosts (for git clone/fetch)
- Package registries (npm, PyPI, etc.)
- The Relay broker at `RELAYD_TUNNEL_HOST:RELAYD_TUNNEL_PORT`

Deny-by-default egress filtering is enforced by the Cube host's eBPF policy, not this image.

## Building and Verification

### Prerequisites
- Cube host with `e2b` CLI authenticated
- Local copy of relayd source (`../relayd/src`, `../relayd/bin`, `../relayd/package.json`)

### Build
```bash
cd product/trial
bash build.sh
```

### Verify
```bash
# Syntax check
bash -n start.sh build.sh
shellcheck start.sh build.sh  # if installed

# Enroll flow dry-run (if test exists)
cd product/relayd && node --test test/enroll-cli.test.mjs
```
