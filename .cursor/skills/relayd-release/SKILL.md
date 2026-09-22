---
name: relayd-release
description: Publish a signed relayd release and roll it out to every paired machine. Use when the user asks to update relayd on all devices, on the fleet, or on every machine, or to cut/publish/ship a relayd release. Runs ops/release-relayd; never touches a machine directly.
---

# Update relayd on all devices

One command publishes; the machines update themselves. `ops/release-relayd`
builds the tarball from `product/relayd/`, signs its digest with the operator's
Ed25519 key, uploads it to the control plane, and announces the version there. Every paired node sees the announcement on the
long-poll it already holds open, verifies the signature against the public key
installed on it, stages the release, waits until it is idle, and applies it —
rolling back itself if the new build fails its health check.

Normative design: `docs/superpowers/specs/2026-09-21-relayd-release-subscription.md`.

## Do this

1. Confirm what is being shipped. Show the user the `product/relayd` commits
   since the currently published version (`ops/release-relayd` reads the
   version from `product/relayd/package.json`) and the target version. If
   `product/relayd` has uncommitted changes, stop and say so — do not pass
   `--allow-dirty` unless the user explicitly asks for it.
2. Bump `version` in `product/relayd/package.json` when the user is shipping
   something new, and commit that with the work it describes.
3. Dry run first, always: `ops/release-relayd --local-only`. This builds and
   signs without uploading or announcing anything. Report the version, digest
   and key id.
4. Publish: `ops/release-relayd --channel stable`. Add `--notes "<one line>"`
   when there is something worth recording. The command then watches
   `/v1/admin/nodes` and prints each machine as it converges.
5. Report per machine: the version it runs now, anything it has staged but not
   yet applied, and any machine that did not converge before the watch window
   closed. A machine mid-run stays on the old version until it is idle; that is
   correct behaviour, not a failure.

Use `--channel beta` when the user wants one machine to take the release first.
Use `--no-watch` when they do not want to wait.

## Rules

- Never SSH, `scp`, `rsync` or use AWS SSM to update a machine. The whole point
  of this path is that the laptop publishes and nodes pull. Reaching into a
  machine also collides with the guarded-VPC rule for `poc-ec2`.
- Never print, echo, or paste the signing key or the admin token. The key id and
  the artifact digest are safe to show; the key material is not.
- Never publish a version lower than the one already published on that channel.
  Nodes refuse downgrades, so this only produces a confusing announcement.
- If the signing key is missing, do not work around it and do not switch to
  cloud-side signing. Report it: an unsigned release is one no node will accept,
  by design.
- If the control plane rejects the admin token or is unreachable, the release is
  not published. Say that plainly rather than reporting success from a
  successful upload.

## First time on a machine

A machine can only self-update once it runs a `relayd` that knows how, with the
release public key installed. That is a one-time bootstrap per machine, done by
its operator:

```bash
RELAYD_RELEASE_PUBKEY="$(ops/release-relayd --print-public-key)" \
  sudo -E product/relayd/dist/install.sh
```

`install.sh` leaves an already-installed key untouched, so re-running it is
safe. Until a machine has been through this once, it will report its version
and ignore announcements; `relayd update --check` on the machine says which
state it is in — running version, channel, whether auto-apply is on, whether
the key is present, and the last announcement it saw.
