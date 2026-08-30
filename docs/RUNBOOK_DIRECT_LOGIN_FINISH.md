# Runbook — finish direct provider login (local session, full access)

> Written 2026-08-29 by the cloud session that shipped the feature. That
> session had no Xcode, no simulator, no AWS, and no node access — this
> runbook is the hand-off to a session on the operator's Mac that has all
> of it. Everything below is already on `main` (`58bdb03`); nothing is
> uncommitted.

## Current state (verified facts, not guesses)

- **relayd** (`product/relayd`): direct-login routes shipped and tested —
  `POST /v1/harness/ops/:id/{input,callback,cancel}`, login children get
  piped stdin, `RELAYD_HARNESS_CALLBACK_PORTS` (default codex→1455).
  Suite: 495/497 locally in the cloud sandbox; the 2 failures reproduce
  on the pre-change base commit there (container quirks), and
  `harness-home.test.mjs` cannot run in that sandbox at all (`/proc`
  mkdir spins). **Run the full suite on the Mac — expected fully green.**
- **iOS**: `ProviderLoginFlowModel/View` with two engines: the modern op
  engine, and an exec fallback (`/v1/exec` + `GET /v1/harness` only) that
  launches the login under util-linux `script` (PTY), setsid-detached,
  log-file polling, FIFO stdin, exec callback replay. Compiles green in
  the mobile-parity workflow's simulator job. **`xcodebuild test` has
  never been run on this code — do that first.**
- **The user's live machine still runs pre-change relayd.** Field
  evidence from the phone: the op starts but `codex login` prints
  nothing (op engine, old build), and the terminals API produces zero
  output — terminals ride the Codex app-server, which hangs when codex
  has never signed in (why the fallback was rebuilt on exec).
- Mobile-parity workflow is green again (run 20+). Reminder: every push
  touching `ios/POCVault/POCVault/` must also touch
  `mobile/parity-contract.json` (or Android/relay-core) in the same push.

## Finish line (in order)

1. **iOS tests on the Mac** (first — never yet run):
   ```bash
   xcodebuild test -project ios/POCVault/POCVault.xcodeproj \
     -scheme POCVault -destination 'platform=iOS Simulator,name=iPhone 17'
   ```
   Fix anything red (most likely candidates: Swift concurrency warnings
   in `ProviderLoginFlowModel`, the `ProviderLoginTests` stub).

2. **Update relayd on the live node** — this is THE fix; with it the
   phone uses the clean op engine and the fallback becomes insurance.
   Discovery first (how relayd runs there is not recorded anywhere):
   ```bash
   source ~/.poc-vault/secrets/config.env
   ssh -i "$KEY_PATH" "$DEPLOY_USER@$DEPLOY_HOST" \
     'systemctl status relayd 2>/dev/null; ps aux | grep -E "relayd|node .*relayd" | grep -v grep; which relayd'
   ```
   Then sync `product/relayd` from `main` to wherever it runs, restart
   the service, and verify from the node itself:
   ```bash
   # on the node — expect 404 op-not-found (route EXISTS), not generic "not found"
   curl -s -X POST localhost:<relayd-port>/v1/harness/ops/00000000-0000-4000-8000-000000000000/cancel
   ```
   If the "machine" is a Cube trial sandbox instead of a plain relayd on
   EC2: rebuild the template (`product/trial/build.sh` against the Cube
   host per `product/trial/README.md`), then delete + recreate the trial
   from the phone so it boots the new image.

3. **Sanity-check `script`, `mkfifo`, `setsid`, `node`, `pkill` exist on
   the node** (the exec fallback shells out to them):
   ```bash
   ssh ... 'for c in script mkfifo setsid node pkill; do command -v $c || echo "MISSING $c"; done'
   ```

4. **End-to-end from the phone** (TestFlight build ≥ `58bdb03`):
   Settings → Coding agents → Sign in to Codex → browser → done. Claude
   Code: same, paste the code. If anything stalls, the sheet now shows
   the machine's own output/error — that text is the next bug report.

5. Optional cleanups the cloud session left behind:
   - `product/relayd` deploy story is undocumented — record it in
     STATUS.md once discovered.
   - `DEVICE_LOGIN_URL` still unset on the control-plane host
     (STATUS.md item 13b) — unrelated to this feature but adjacent.
