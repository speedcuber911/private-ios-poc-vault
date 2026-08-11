#!/usr/bin/env python3
"""Add Relay control-plane routes to the existing Relay Server Caddy site."""

from __future__ import annotations

import argparse
import datetime as dt
import os
import shutil
import tempfile
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--caddyfile", required=True, type=Path)
    parser.add_argument("--upstream", required=True)
    parser.add_argument(
        "--hosts",
        required=True,
        help="Comma-separated Caddy site labels, including the existing label",
    )
    args = parser.parse_args()

    path = args.caddyfile
    source = path.read_text(encoding="utf-8")
    begin = "# BEGIN RELAY CODEX API\n"
    end = "# END RELAY CODEX API"
    if source.count(begin) != 1 or source.count(end) != 1:
        raise SystemExit("Relay Caddy block markers are missing or ambiguous")

    prefix, remainder = source.split(begin, 1)
    relay_block, suffix = remainder.split(end, 1)
    lines = relay_block.splitlines()
    site_index = next(
        (index for index, line in enumerate(lines) if line.strip() and not line.lstrip().startswith("#")),
        None,
    )
    if site_index is None or not lines[site_index].rstrip().endswith("{"):
        raise SystemExit("Could not locate the Relay Caddy site label")
    lines[site_index] = f"{args.hosts} {{"
    relay_block = "\n".join(lines) + "\n"

    route_marker = "\t# BEGIN RELAY CONTROL PLANE\n"
    if route_marker not in relay_block:
        anchor = "\t@relayManifest {\n"
        if relay_block.count(anchor) != 1:
            raise SystemExit("Could not locate the Relay manifest matcher")
        routes = f"""\t# BEGIN RELAY CONTROL PLANE
\t@relayCloud {{
\t\tpath /api/auth /api/auth/* /v1/account /v1/devices /v1/devices/* /v1/nodes /v1/nodes/* /v1/pairing/* /v1/waitlist /v1/node-events /v1/tunnel/* /v1/admin/*
\t}}
\thandle @relayCloud {{
\t\treverse_proxy {args.upstream}
\t}}
\t# END RELAY CONTROL PLANE

"""
        relay_block = relay_block.replace(anchor, routes + anchor)

    updated = prefix + begin + relay_block + end + suffix
    if updated == source:
        print("Caddyfile already configured")
        return

    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup = path.with_name(f"{path.name}.relay-backup-{stamp}")
    shutil.copy2(path, backup)

    fd, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(updated)
        os.chmod(temporary_name, path.stat().st_mode)
        os.replace(temporary_name, path)
    finally:
        if os.path.exists(temporary_name):
            os.unlink(temporary_name)

    print(f"Caddyfile updated; backup: {backup}")


if __name__ == "__main__":
    main()
