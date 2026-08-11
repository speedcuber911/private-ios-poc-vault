#!/usr/bin/env python3
"""Render an isolated nginx virtual host for the Relay control plane."""

from __future__ import annotations

import argparse
import os
import re
import tempfile
from pathlib import Path


DOMAIN_RE = re.compile(r"(?=^.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$")
UPSTREAM_RE = re.compile(r"(?:127\.0\.0\.1|\[::1\]):[1-9][0-9]{0,4}$")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--domain", required=True)
    parser.add_argument("--upstream", default="127.0.0.1:8790")
    parser.add_argument(
        "--template",
        type=Path,
        default=Path(__file__).with_name("relay-cloud.nginx.conf.template"),
    )
    parser.add_argument(
        "--http-only",
        action="store_true",
        help="Render the temporary port-80 ACME bootstrap virtual host",
    )
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()

    domain = args.domain.strip().lower().rstrip(".")
    if not DOMAIN_RE.fullmatch(domain):
        raise SystemExit("Invalid Relay domain")
    if not UPSTREAM_RE.fullmatch(args.upstream):
        raise SystemExit("Upstream must be a loopback host and valid port")

    template = (
        Path(__file__).with_name("relay-cloud.nginx-http.conf.template")
        if args.http_only
        else args.template
    )
    rendered = (
        template.read_text(encoding="utf-8")
        .replace("__RELAY_DOMAIN__", domain)
        .replace("__RELAY_UPSTREAM__", args.upstream)
    )
    if "__RELAY_" in rendered:
        raise SystemExit("Unresolved Relay nginx placeholder")

    args.output.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary_name = tempfile.mkstemp(prefix=f".{args.output.name}.", dir=args.output.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(rendered)
        os.chmod(temporary_name, 0o644)
        os.replace(temporary_name, args.output)
    finally:
        if os.path.exists(temporary_name):
            os.unlink(temporary_name)

    print(f"Wrote {args.output}")


if __name__ == "__main__":
    main()
