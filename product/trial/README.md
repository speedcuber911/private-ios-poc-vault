# Relay Trial Template

A Cube/E2B template for running the Relay agent in a sandboxed, tunneled environment.

## Template Contents

- **Base**: Ubuntu 24.04 with Node 22, curl, git, ripgrep, and dependencies
- **Harness CLIs**: `@openai/codex`, `@anthropic-ai/claude-code` (preinstalled, unauthenticated)
- **Runtime User**: Non-root `relay` account
- **Workspaces**: Jail at `/srv/relay-workspaces` with a seeded welcome workspace
- **Init**: `start.sh` (no systemd; runs as PID 1)

## Environment Contract

The sandbox receives the following environment variables, injected by relay-cloud:

**Enrollment** (consumed once on first boot, then cleared):
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
