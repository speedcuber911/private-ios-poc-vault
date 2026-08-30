# Relay trial machine template (Cube / E2B). No systemd: the sandbox runs
# start.sh as its init. Harness CLIs are preinstalled but UNAUTHENTICATED —
# the user connects their own subscriptions after boot.
#
# BASE IMAGE IS NOT NEGOTIABLE. Cube talks to every sandbox exclusively
# through `envd`, an in-container daemon on :49983 — it serves the template
# readiness probe (`GET :49983/health`), sandbox init, command execution and
# the file APIs. An image without envd cannot be booted at all: CubeMaster
# fails the container with `Exec mount failed: exec process exit code: 1`
# (observed on a plain ubuntu:24.04 base) and every sandbox create returns
# 500. `cubesandbox-base` is ubuntu:22.04 with envd preinstalled and an
# entrypoint that runs it in the background while honoring our CMD, so the
# CMD below still starts relayd. The tag pins the envd version for
# reproducible builds.
FROM ghcr.io/tencentcloud/cubesandbox-base:2026.16

RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates curl git openssl python3 ripgrep unzip util-linux xz-utils \
    && rm -rf /var/lib/apt/lists/*

# Node 22 (relayd floor; also used by the harness CLIs).
RUN curl -fsSL https://nodejs.org/dist/v22.23.1/node-v22.23.1-linux-x64.tar.xz \
      | tar -xJ -C /opt && ln -s /opt/node-v22.23.1-linux-x64 /opt/node
ENV PATH="/opt/node/bin:${PATH}"

# Non-root runtime user + jail with a seeded welcome workspace. Created
# before the harness CLI installs below so the Cursor installer (which is
# HOME-relative) can land its binary under /home/relay.
RUN useradd --system --create-home --shell /bin/bash relay \
    && mkdir -p /srv/relay-workspaces/welcome /var/lib/relayd \
    && printf '# Welcome to your Relay trial machine\n\nThis folder is your agent workspace. Open a conversation from the app to get started.\n' \
         > /srv/relay-workspaces/welcome/README.md \
    && chown -R relay:relay /srv/relay-workspaces /var/lib/relayd \
    && chmod 0750 /srv/relay-workspaces

# Harness CLIs, pinned at template-build time (versions recorded in the image).
# Codex/Claude Code/Kimi install into the global npm prefix (/opt/node), which is
# not HOME-relative. Cursor's installer writes to $HOME/.local/bin, so it
# must run with HOME=/home/relay (relayd's cursorBin default resolves to
# $CODEX_RUN_HOME/.local/bin/cursor-agent, and start.sh sets
# CODEX_RUN_HOME=/home/relay) — otherwise it lands in /root and the runtime
# `relay` user never sees it. A Cursor install failure only degrades one of
# four harnesses and must not fail the whole image build, but it must leave
# a visible signal instead of being silently swallowed.
# `pipefail` is essential here, not stylistic: without it the pipeline's exit
# status is bash's, and a curl that never reaches cursor.com pipes zero bytes
# into a bash that exits 0 — so the warning below would never fire on the one
# failure mode it exists to catch.
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
RUN npm install -g @openai/codex @anthropic-ai/claude-code @moonshot-ai/kimi-code
RUN if curl -fsSL https://cursor.com/install | HOME=/home/relay bash; then \
      echo "cursor-agent installed"; \
    else \
      echo "WARNING: cursor-agent install failed; Cursor CLI will be unavailable at runtime (continuing build)" >&2; \
    fi; \
    if [ -d /home/relay/.local ]; then chown -R relay:relay /home/relay/.local; fi
SHELL ["/bin/sh", "-c"]

# relayd source (stdlib-only; no npm install step by design).
COPY relayd/src /opt/relayd/app/src
COPY relayd/bin /opt/relayd/app/bin
COPY relayd/package.json /opt/relayd/app/package.json
COPY start.sh /opt/relayd/start.sh
COPY src /opt/relayd/src
COPY sample /opt/relayd/sample
RUN chmod 0755 /opt/relayd/start.sh /opt/relayd/app/bin/relayd

# Deliberately NO image-level `USER relay`. The base entrypoint has to start
# envd as root because envd mounts inside the sandbox; setting USER here is
# exactly what produced `Exec mount failed: exec process exit code: 1`.
# start.sh uses util-linux runuser only after envd is alive, so relayd and every
# provider harness run as `relay`. This is also required by Codex's bubblewrap
# user namespace: a root-launched relayd cannot traverse the relay-owned 0750
# workspace jail after entering that namespace.
WORKDIR /home/relay
CMD ["/opt/relayd/start.sh"]
