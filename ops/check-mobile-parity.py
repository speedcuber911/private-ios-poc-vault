#!/usr/bin/env python3
"""Fail when Relay's declared cross-platform behavior or change discipline drifts."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CONTRACT_PATH = ROOT / "mobile/parity-contract.json"
IOS_SHARED_PREFIX = "ios/POCVault/POCVault/"
ANDROID_SHARED_PREFIX = "mobile/androidApp/src/main/"
CORE_PREFIX = "mobile/relay-core/"


def fail(messages: list[str]) -> None:
    for message in messages:
        print(f"mobile parity: {message}", file=sys.stderr)
    raise SystemExit(1)


def changed_files(base: str) -> set[str]:
    probe = subprocess.run(
        ["git", "cat-file", "-e", f"{base}^{{commit}}"], cwd=ROOT, capture_output=True
    )
    if probe.returncode != 0:
        print(f"mobile parity: base {base!r} is unavailable; evidence checks still ran")
        return set()
    result = subprocess.run(
        ["git", "diff", "--name-only", f"{base}...HEAD"],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    changed = {line.strip() for line in result.stdout.splitlines() if line.strip()}
    for command in (["git", "diff", "--name-only"], ["git", "diff", "--cached", "--name-only"]):
        local = subprocess.run(command, cwd=ROOT, check=True, capture_output=True, text=True)
        changed.update(line.strip() for line in local.stdout.splitlines() if line.strip())
    return changed


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", help="Git base commit used to reject one-sided shared-surface changes")
    args = parser.parse_args()

    contract = json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))
    errors: list[str] = []
    if contract.get("schemaVersion") != 1:
        errors.append("mobile/parity-contract.json has an unsupported schemaVersion")

    core_info = (ROOT / "mobile/relay-core/src/commonMain/kotlin/live/relay/core/RelayCoreInfo.kt").read_text(encoding="utf-8")
    expected_core_version = f"schemaVersion: Int = {contract.get('sharedCoreSchemaVersion')}"
    if expected_core_version not in core_info:
        errors.append("sharedCoreSchemaVersion does not match RelayCoreInfo")

    capability_ids: set[str] = set()
    for capability in contract.get("capabilities", []):
        capability_id = capability.get("id", "<missing id>")
        if capability_id in capability_ids:
            errors.append(f"duplicate capability id {capability_id}")
        capability_ids.add(capability_id)
        surfaces = capability.get("surfaces", {})
        for platform in ("shared", "ios", "android"):
            evidence = surfaces.get(platform, [])
            if not evidence:
                errors.append(f"{capability_id} has no {platform} evidence")
            for item in evidence:
                path = ROOT / item.get("path", "")
                if not path.is_file():
                    errors.append(f"{capability_id} references missing file {path.relative_to(ROOT)}")
                    continue
                content = path.read_text(encoding="utf-8")
                for needle in item.get("contains", []):
                    if needle not in content:
                        errors.append(f"{capability_id} lost {platform} evidence {needle!r} in {path.relative_to(ROOT)}")

    for difference in contract.get("knownDifferences", []):
        if not difference.get("id") or not difference.get("status") or not difference.get("reason"):
            errors.append("every knownDifference needs id, status, and reason")

    if args.base:
        changed = changed_files(args.base)
        ios_changed = any(path.startswith(IOS_SHARED_PREFIX) for path in changed)
        android_changed = any(path.startswith(ANDROID_SHARED_PREFIX) for path in changed)
        core_changed = any(path.startswith(CORE_PREFIX) for path in changed)
        contract_changed = "mobile/parity-contract.json" in changed
        if ios_changed and not (android_changed or core_changed or contract_changed):
            errors.append("shared iOS behavior changed without Android/shared-core work or an explicit parity-contract review")
        if android_changed and not (ios_changed or core_changed or contract_changed):
            errors.append("shared Android behavior changed without iOS/shared-core work or an explicit parity-contract review")

    if errors:
        fail(errors)
    print(f"mobile parity: {len(capability_ids)} shared capabilities verified")


if __name__ == "__main__":
    main()
