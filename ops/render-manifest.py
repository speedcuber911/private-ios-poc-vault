#!/usr/bin/env python3
"""Render a deterministic POC Vault manifest from pocs/*/poc.json."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any


SLUG_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")
REQUIRED_FIELDS = ("slug", "title", "description")
OPTIONAL_METADATA_FIELDS = ("createdAt", "updatedAt", "tags", "icon", "accentColor")


class ManifestError(Exception):
    """Raised when a POC cannot be represented safely in the manifest."""


def validate_slug(slug: str) -> None:
    if not SLUG_RE.fullmatch(slug):
        raise ManifestError(
            f"Invalid slug {slug!r}. Use lowercase letters, numbers, and hyphens only."
        )


def sha256_file(path: Path) -> tuple[str, int]:
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            size += len(chunk)
            digest.update(chunk)
    return digest.hexdigest(), size


def hash_public_tree(public_dir: Path) -> tuple[str, int, list[dict[str, Any]]]:
    if not public_dir.is_dir():
        raise ManifestError(f"Missing public directory: {public_dir}")

    files: list[dict[str, Any]] = []
    total_bytes = 0
    for path in sorted(p for p in public_dir.rglob("*") if p.is_file()):
        rel = path.relative_to(public_dir).as_posix()
        file_hash, file_bytes = sha256_file(path)
        total_bytes += file_bytes
        files.append({"path": rel, "sha256": file_hash, "bytes": file_bytes})

    if not files:
        raise ManifestError(f"No files found in public directory: {public_dir}")
    if not any(item["path"] == "index.html" for item in files):
        raise ManifestError(f"Missing public/index.html under: {public_dir.parent}")

    tree_digest = hashlib.sha256()
    for item in files:
        tree_digest.update(
            f"{item['sha256']} {item['bytes']} {item['path']}\n".encode("utf-8")
        )
    return tree_digest.hexdigest(), total_bytes, files


def entry_url(base_url: str | None, slug: str) -> str | None:
    if not base_url:
        return None
    rendered = base_url.format(slug=slug).rstrip("/")
    return f"{rendered}/"


def load_poc(poc_json: Path, base_url: str | None) -> dict[str, Any]:
    try:
        metadata = json.loads(poc_json.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ManifestError(f"Invalid JSON in {poc_json}: {exc}") from exc

    for field in REQUIRED_FIELDS:
        if not isinstance(metadata.get(field), str) or not metadata[field].strip():
            raise ManifestError(f"{poc_json} must contain a non-empty string {field!r}")

    slug = metadata["slug"]
    validate_slug(slug)
    if poc_json.parent.name != slug:
        raise ManifestError(
            f"{poc_json} slug {slug!r} must match directory {poc_json.parent.name!r}"
        )

    tree_hash, artifact_bytes, files = hash_public_tree(poc_json.parent / "public")
    poc: dict[str, Any] = {
        "artifactBytes": artifact_bytes,
        "artifactHash": f"sha256:{tree_hash}",
        "description": metadata["description"].strip(),
        "entrypoint": "index.html",
        "files": files,
        "path": "/index.html",
        "slug": slug,
        "title": metadata["title"].strip(),
    }
    url = entry_url(base_url, slug)
    if url:
        poc["url"] = url

    for field in OPTIONAL_METADATA_FIELDS:
        if field in metadata:
            poc[field] = metadata[field]

    passthrough = {
        key: value
        for key, value in metadata.items()
        if key not in REQUIRED_FIELDS and key not in OPTIONAL_METADATA_FIELDS
    }
    if passthrough:
        poc["metadata"] = dict(sorted(passthrough.items()))

    return poc


def render_manifest(pocs_dir: Path, base_url: str | None = None) -> dict[str, Any]:
    if not pocs_dir.is_dir():
        raise ManifestError(f"POC directory does not exist: {pocs_dir}")

    poc_files = sorted(pocs_dir.glob("*/poc.json"))
    if not poc_files:
        raise ManifestError(f"No poc.json files found under {pocs_dir}")

    pocs = [load_poc(path, base_url) for path in poc_files]
    return {
        "generatedAt": dt.datetime.now(dt.timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z"),
        "pocs": sorted(pocs, key=lambda item: item["slug"]),
        "schemaVersion": 1,
    }


def write_json(data: dict[str, Any], output: Path | None) -> bytes:
    rendered = json.dumps(data, indent=2, sort_keys=True, ensure_ascii=False)
    payload = (rendered + "\n").encode("utf-8")
    if output:
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(payload)
    else:
        sys.stdout.buffer.write(payload)
    return payload


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pocs-dir", type=Path, default=Path("pocs"))
    parser.add_argument("--base-url", default=None)
    parser.add_argument("-o", "--output", type=Path, default=None)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    try:
        manifest = render_manifest(args.pocs_dir, args.base_url)
        payload = write_json(manifest, args.output)
    except ManifestError as exc:
        print(f"render-manifest: {exc}", file=sys.stderr)
        return 1

    if args.output:
        print(
            f"Wrote {args.output} ({len(manifest['pocs'])} POCs, "
            f"sha256:{hashlib.sha256(payload).hexdigest()})"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
