#!/usr/bin/env python3
"""Sign a rendered POC Vault manifest with an Ed25519 private key."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import sys
from pathlib import Path
from typing import Any


DEFAULT_KEY = Path("~/.poc-vault/secrets/signing/manifest-ed25519.key").expanduser()


class SigningError(Exception):
    """Raised when a manifest cannot be signed."""


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def decode_raw_key(data: bytes) -> bytes | None:
    text = b"".join(data.split()).decode("ascii", errors="ignore")
    if not text:
        return None

    if len(text) in (64, 128) and all(ch in "0123456789abcdefABCDEF" for ch in text):
        raw = bytes.fromhex(text)
    else:
        padded = text + "=" * (-len(text) % 4)
        try:
            raw = base64.urlsafe_b64decode(padded.encode("ascii"))
        except Exception:
            try:
                raw = base64.b64decode(padded.encode("ascii"))
            except Exception:
                return None

    if len(raw) == 32:
        return raw
    if len(raw) == 64:
        return raw[:32]
    return None


def load_private_key(path: Path) -> Any:
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ed25519

    data = path.read_bytes()

    loaders = (
        serialization.load_pem_private_key,
        serialization.load_ssh_private_key,
    )
    for loader in loaders:
        try:
            key = loader(data, password=None)
        except Exception:
            continue
        if isinstance(key, ed25519.Ed25519PrivateKey):
            return key
        raise SigningError(f"{path} is not an Ed25519 private key")

    raw = decode_raw_key(data)
    if raw:
        return ed25519.Ed25519PrivateKey.from_private_bytes(raw)

    raise SigningError(
        f"Could not parse {path}. Use PEM/OpenSSH Ed25519, raw 32-byte hex, or base64."
    )


def sign_manifest(manifest: Path, key_path: Path) -> dict[str, Any]:
    from cryptography.hazmat.primitives import serialization

    payload = manifest.read_bytes()
    key = load_private_key(key_path)
    signature = key.sign(payload)
    public_key = key.public_key().public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )
    manifest_hash = hashlib.sha256(payload).hexdigest()
    key_hash = hashlib.sha256(public_key).digest()
    return {
        "algorithm": "Ed25519",
        "keyId": f"sha256:{b64url(key_hash)}",
        "manifest": manifest.name,
        "manifestSha256": f"sha256:{manifest_hash}",
        "publicKey": b64url(public_key),
        "signature": b64url(signature),
        "signatureEncoding": "base64url",
        "signedPayload": "manifest-bytes",
    }


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    parser.add_argument(
        "--key",
        type=Path,
        default=DEFAULT_KEY,
        help=f"Ed25519 private key path (default: {DEFAULT_KEY})",
    )
    parser.add_argument("-o", "--output", type=Path, default=None)
    parser.add_argument(
        "--allow-missing-key",
        action="store_true",
        help="Exit successfully without writing a signature if the key is missing.",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    key_path = args.key.expanduser()
    output = args.output or args.manifest.with_suffix(args.manifest.suffix + ".sig.json")

    if not args.manifest.is_file():
        print(f"sign-manifest: missing manifest: {args.manifest}", file=sys.stderr)
        return 1
    if not key_path.is_file():
        message = f"sign-manifest: signing key not found: {key_path}"
        if args.allow_missing_key:
            print(f"{message}; skipping signature")
            return 0
        print(message, file=sys.stderr)
        return 1

    try:
        signature = sign_manifest(args.manifest, key_path)
    except SigningError as exc:
        print(f"sign-manifest: {exc}", file=sys.stderr)
        return 1

    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        json.dumps(signature, indent=2, sort_keys=True, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    print(f"Wrote {output} ({signature['manifestSha256']})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
