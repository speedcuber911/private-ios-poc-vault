# Relay POC EC2 deployment — next-agent handoff

> Complete implementation and operations handoff for the work performed on
> 2026-08-11. Read this before changing Relay cloud infrastructure, the shared
> POC EC2, nginx, Route 53, backups, or the deployment pipeline.

## Executive state

The Relay account/control-plane service in `product/cloud` is deployed and
publicly healthy in the user's non-Cut AWS account.

- Use AWS CLI profile `default`, not `cut-personal` or any Cut profile.
- Account: `507121383669`.
- Region: `ap-south-1`.
- Target: `poc-ec2`, instance `i-0ce97c38c7fd74825`.
- Public API: `https://relay.ai-rocket-experiments.com`.
- Current deployed CodeCommit revision:
  `97ac329a20377af3212444973d9946c171cb7f0a`.
- CodePipeline execution `6f86db2d-a8ca-4fe8-bdfe-24fd7dc32da6` succeeded.
- CodeBuild execution
  `relay-cloud-deploy:56d30cf0-94d5-4216-a24f-425ac0f88d50` succeeded.
- The service, SQLite database, online backup timer, nginx route, public TLS,
  Route 53 record, dedicated CodeCommit repository, and AWS-native CI/CD path
  are live.
- The raw tunnel broker, the personal agent runner, static POC hosting, and the
  native iOS application were deliberately not migrated by this rollout.

The deployment is not a claim that every Relay product surface is production
complete. Real APNs, mail, Sign in with Apple credentials, the finished broker
transport, and a rebuilt iPhone app still require separate work.

## Non-negotiable context

1. Always include `--profile default --region ap-south-1` on AWS CLI calls for
   this deployment. Re-run `aws sts get-caller-identity` before a mutation if
   there is any doubt.
2. Preserve the existing apps and listeners on `poc-ec2`. nginx, PostgreSQL,
   Flux, Flux Gateway, and MIQ were already present.
3. Do not put Claude on Bedrock in this account. Direct Codex, Claude, and
   Cursor auth belongs only in the isolated agent-runner home.
4. Never print or commit `/etc/relay-cloud/env` or anything under
   `~/.poc-vault/secrets`.
5. Do not expose port `8790`; it must remain loopback-only behind nginx.
6. Do not move the raw broker onto shared ports 80/443 until its ingress design
   is finished and the existing nginx applications have a safe migration plan.
7. Static POCs still deploy through `ops/deploy-poc`. Ordinary POC work must
   not edit `ios/POCVault/`.

## Final topology

```text
Route 53: relay.ai-rocket-experiments.com
                  |
                  v
       poc-ec2 public 80/443
                  |
        nginx + Let's Encrypt
                  |
                  v
       127.0.0.1:8790 relay-cloud
                  |
                  v
 /var/lib/relay-cloud/relay-cloud.sqlite
                  |
      nightly online backup + checksum
                  |
                  v
s3://relay-poc-backups-507121383669-ap-south-1/relay-cloud/
```

The data-path node and provider credentials remain outside this diagram. The
cloud stores account/control-plane metadata and rendezvous data only; prompts,
source, job output, workspaces, provider credentials, and node CA private keys
do not belong on it.

## AWS resources

### Existing target resources used

| Resource | Value | Notes |
| --- | --- | --- |
| EC2 | `i-0ce97c38c7fd74825` / `poc-ec2` | Ubuntu 22.04, `t3.large`, SSM Online |
| Instance role/profile | `poc-ec2-instance` | Existing role extended only with scoped Relay policies |
| Root volume | `vol-0ff94300ecb78b9d9` | 40 GiB gp3, encrypted |
| Security group | existing POC EC2 group | Public 22/80/443 only; no 8790 ingress added |
| Route 53 zone | `Z080645839I5BO3TEQ366` | Public zone `ai-rocket-experiments.com` |

`conformal.live` is not hosted in this AWS account. That is why the final API
host is `relay.ai-rocket-experiments.com`, not a `conformal.live` name.

### Recovery and backup resources created

| Resource | Value | State |
| --- | --- | --- |
| Pre-deploy EBS snapshot | `snap-0027cd41761bc9dd7` | completed, encrypted, 100% |
| Backup bucket | `relay-poc-backups-507121383669-ap-south-1` | private, versioned, SSE-S3 |
| Backup prefix | `relay-cloud/` | instance role limited to this prefix |
| Instance inline policy | `relay-cloud-backup-s3` | List bucket plus Get/Put for Relay prefix only |

The bucket has all four S3 block-public-access switches enabled. Its lifecycle
configuration expires non-current backup versions and aborts incomplete
uploads. The instance has no general-purpose S3 write permission.

### CI/CD resources created by CloudFormation

Stack: `relay-cloud-cicd`.

| Resource | Name |
| --- | --- |
| Source repository | CodeCommit `relay-cloud` |
| Source branch | `main` |
| Pipeline | `relay-cloud-deploy` |
| Build project | `relay-cloud-deploy` |
| Source trigger | EventBridge rule `relay-cloud-main-updated` |
| Artifact bucket | `relay-cloud-cicd-507121383669-ap-south-1` |
| Pipeline role | `relay-cloud-codepipeline` |
| Build/deploy role | `relay-cloud-codebuild-deploy` |
| Event role | `relay-cloud-codecommit-events` |
| Target read policy | `relay-cloud-cicd-release-read` |

The artifact bucket is private, encrypted, versioned, and has 30-day release
and pipeline-artifact expiration rules. The target can read only its
`releases/` objects. CodeBuild can send and inspect SSM commands only for the
deployment workflow encoded in the stack.

## Shared-host inventory that must remain intact

Before Relay, `poc-ec2` already ran:

| Unit/application | Listener or route observed |
| --- | --- |
| nginx | public 80/443 |
| PostgreSQL 14 | `127.0.0.1:5432` |
| existing agent/API service | port 8787 |
| MIQ | port 3030 and `miq.ai-rocket-experiments.com` |
| Flux | port 3040 and `jisha.ai-rocket-experiments.com` |
| Flux Gateway | existing systemd unit |

Final regression evidence was:

```text
nginx=active
postgresql=active
flux-gateway=active
flux=active
miq=active
jisha_root=200
miq_root=302
```

nginx emits pre-existing warnings for duplicate `jisha` server names and
certificates without OCSP responder URLs. `nginx -t` still succeeds. Those
unrelated warnings were intentionally not changed during the Relay rollout.

## Host files and units installed

| Path | Owner/mode or purpose |
| --- | --- |
| `/opt/relay-cloud/releases/<sha>` | immutable root-owned release |
| `/opt/relay-cloud/current` | symlink to active release |
| `/opt/relay-cloud/node` | symlink to dedicated verified Node 22 runtime |
| `/etc/relay-cloud/env` | `root:relaycloud`, `0640`, generated secrets and config |
| `/var/lib/relay-cloud` | `relaycloud:relaycloud`, `0750` |
| `/var/lib/relay-cloud/relay-cloud.sqlite` | `relaycloud:relaycloud`, `0600` |
| `/var/backups/relay-cloud` | root-owned local backup staging |
| `/etc/systemd/system/relay-cloud.service` | account/control-plane service |
| `/etc/systemd/system/relay-cloud-backup.service` | one-shot online backup |
| `/etc/systemd/system/relay-cloud-backup.timer` | nightly backup schedule |
| `/etc/nginx/sites-available/relay-cloud` | public TLS reverse proxy |
| `/etc/nginx/sites-enabled/relay-cloud` | enabled vhost symlink |
| `/etc/nginx/conf.d/relay-cloud-rate-limit.conf` | scoped request-limit zone |
| `/var/backups/relay-cloud/nginx/` | timestamped pre-change nginx backup |

`sqlite3` was installed on the target for online backup and integrity checks.
The Relay installer does not replace the global Node runtime; it downloads the
current Node 22 archive from `nodejs.org`, verifies it against the official
SHA-256 manifest, and installs it below `/opt/relay-cloud`.

## Repository implementation

### Deployment and runtime files

| File | Purpose |
| --- | --- |
| `product/cloud/deploy/install.sh` | explicit loopback bind, dedicated Node 22, immutable SHA releases, on-host secrets, rollback, backup timer, DB permissions |
| `product/cloud/deploy/relay-cloud.service` | hardened service, dedicated Node, `UMask=0077` |
| `product/cloud/deploy/backup-sqlite.sh` | online backup, integrity validation, compression, checksum, S3 upload |
| `product/cloud/deploy/verify-backup.sh` | disposable checksum/decompress/integrity/table verification |
| `product/cloud/deploy/relay-cloud-backup.service` | root one-shot backup unit |
| `product/cloud/deploy/relay-cloud-backup.timer` | nightly timer |
| `product/cloud/deploy/configure-nginx.py` | safe atomic HTTP-bootstrap or TLS vhost rendering |
| `product/cloud/deploy/relay-cloud.nginx-http.conf.template` | ACME bootstrap vhost |
| `product/cloud/deploy/relay-cloud.nginx.conf.template` | final HTTP redirect + TLS proxy vhost |
| `product/cloud/deploy/relay-cloud-rate-limit.conf` | nginx shared rate-limit zone |
| `product/cloud/deploy/buildspec.deploy.yml` | Node 22 tests, validation, deployment entrypoint |
| `product/cloud/deploy/cicd-deploy.sh` | archive upload, SSM install, local/public health gates |
| `product/cloud/deploy/relay-cloud-cicd.yml` | CloudFormation CI/CD resources and permissions |

### Documentation updated

- `docs/RELAY_POC_EC2_DEPLOYMENT.md`: live architecture, state, verification,
  operations, rollback, and remaining product work.
- `docs/RELAY_POC_EC2_AGENT_HANDOFF.md`: this agent-to-agent implementation
  record.
- `product/cloud/README.md`: live deployment, installer, nginx, CI/CD, and
  backup behavior.
- `product/DEPLOY.md`: distinguishes the current public control plane from the
  earlier `relay-router` broker spike.
- `product/STATUS.md`: W3 live deployment, DNS, backup, and CI/CD status.
- `README.md`: links the operational deployment record and this handoff.

## CI/CD source-repository rule

The CodeCommit `relay-cloud` repository is intentionally a standalone service
repository. Its root corresponds to `product/cloud/`, not to this entire
monorepo. This avoids deploying unrelated iOS, broker, POC, or dirty-worktree
files.

The initial CodeCommit history is:

```text
a45af2b Deploy Relay cloud control plane
ec47863 Fix SSM deploy shell compatibility
a70fd24 Harden Relay cloud database permissions
97ac329 Fix pipeline artifact retention prefix
```

Future agents should clone that repository into a clean temporary directory,
overlay only reviewed `product/cloud` changes, run the full suite, commit, and
push `main`. Do not force-push and do not seed it from an unreviewed dirty
monorepo.

Example clone command:

```bash
git \
  -c 'credential.helper=!aws --profile default codecommit credential-helper $@' \
  -c credential.UseHttpPath=true \
  clone https://git-codecommit.ap-south-1.amazonaws.com/v1/repos/relay-cloud
```

After a push, require all of the following:

1. EventBridge starts a new `relay-cloud-deploy` execution.
2. CodeBuild runs Node 22 and all tests pass.
3. SSM completes the installer successfully.
4. CodePipeline reports `Succeeded` for the expected SHA.
5. `/opt/relay-cloud/current` resolves to that exact SHA.
6. Local and public `/healthz` return 200.
7. Existing shared-host applications still pass their checks.

## Deployment timeline and problems encountered

### 1. Account and target correction

The first priority was preventing a cross-account deployment. AWS identity was
re-queried and the selected target was confirmed as `poc-ec2` in the `default`
profile account. No Cut profile was used for the final resources or rollout.

### 2. Read-only inventory and rollback preparation

The EC2, services, listeners, nginx configuration, Route 53 zone, IAM role,
disk, and security group were inventoried before mutation. The encrypted EBS
snapshot `snap-0027cd41761bc9dd7` was created before deployment. nginx was also
archived on the host before the Relay vhost was installed.

### 3. DNS and TLS bootstrap

A temporary HTTP-only nginx vhost served the ACME challenge. Route 53 A record
`relay.ai-rocket-experiments.com` was created with TTL 60 and allowed to reach
`INSYNC`. Certbot then issued the Let's Encrypt certificate, after which the
final TLS vhost and HTTP redirect were installed. The certbot timer was already
present and remains responsible for renewal.

### 4. AWS backup and CI/CD resources

The private backup bucket, scoped role policy, and CloudFormation pipeline
stack were created. The standalone CodeCommit repository was seeded only with
the cloud service and deploy files.

### 5. First pipeline failure: shell compatibility

CodeBuild's tests passed, but SSM failed immediately with:

```text
set: Illegal option -o pipefail
```

`AWS-RunShellScript` starts commands under `/bin/sh`. The generated remote
command in `cicd-deploy.sh` incorrectly began with `set -euo pipefail`.
Revision `ec47863` changed only the remote wrapper to POSIX `set -eu`. The
installer itself is explicitly launched with Bash and correctly retains
`set -euo pipefail`.

Do not reintroduce Bash-only syntax into the SSM wrapper unless the whole
wrapper is explicitly and safely invoked under Bash.

### 6. Post-deploy hardening finding: database mode

The next deployment succeeded and created a healthy 17-table SQLite database,
but live verification found mode `0644`. The parent directory was `0750`, so it
was not publicly reachable, but the file mode was still broader than intended.

Revision `a70fd24` added `UMask=0077` to the service and made the installer
enforce owner `relaycloud:relaycloud` and mode `0600` for the database and
SQLite sidecar files after health succeeds. The final pipeline passed, and the
live database now reports mode `0600`.

### 7. Restart timing during verification

An immediate curl after `systemctl restart` briefly saw connection refused.
The service recovered normally. Any scripted restart check must use
`curl --retry-connrefused` or an explicit readiness loop; a one-shot immediate
curl is not a valid failure signal.

### 8. Artifact lifecycle prefix correction

The final documentation audit found that CodePipeline stores temporary
artifacts below `relay-cloud-deploy/`, while the first CloudFormation lifecycle
rule targeted `codepipeline/`. The rule was corrected in source and in the live
stack. CloudFormation reached `UPDATE_COMPLETE`, and a live bucket read showed
`PipelineArtifactRetention` enabled for `relay-cloud-deploy/` with 30-day
expiration. Revision `97ac329` passed the complete pipeline and became the
final deployed release.

The Git HTTPS push for this one-file change returned 403 even though STS still
confirmed the correct identity and earlier pushes had succeeded. The change
was therefore published with `aws codecommit put-file`, an explicit parent
commit of `a70fd243...`, and the checked-in file content, producing
`97ac329...`. Treat the Git failure as unresolved/transient: verify the
credential helper and branch head before the next push, and never guess a
parent commit for a CodeCommit API write.

## Final verification evidence

### Build and pipeline

```text
CodePipeline status: Succeeded
deployed revision: 97ac329a20377af3212444973d9946c171cb7f0a
CodeBuild Node: 22
cloud tests: 59 pass, 0 fail
```

The same 59-test suite passed locally before the final repository commit.
Shell syntax, Python compilation, nginx rendering, and `git diff --check` also
passed.

### Runtime and database

```text
release=97ac329a20377af3212444973d9946c171cb7f0a
service=active
service_enabled=enabled
listener=127.0.0.1:8790
health={"ok":true}
db_stat=600 relaycloud:relaycloud ... relay-cloud.sqlite
db_integrity=ok
db_tables=17
backup_result=success
backup_timer=active
```

The service survived a restart and returned health after readiness. The
database remained intact.

### Public routing and authorization

```text
DNS A answer: 43.204.94.3
GET /healthz: 200
GET /v1/account without auth: 401
GET /v1/admin/nodes without auth: 401
GET /v1/tunnel/nodes/unknown without auth: 401
```

A randomly generated temporary account completed this live lifecycle:

```text
signup=200
authenticated account read=200
delete account=200
sign in after delete=401
```

The verification script attempted cleanup in a `finally` path and did not log
the generated password or bearer token.

### Backup and restore

An on-demand backup created:

```text
relay-cloud/relay-cloud-20260811T142726Z.sqlite.gz
relay-cloud/relay-cloud-20260811T142726Z.sqlite.gz.sha256
```

The files were downloaded to a disposable local path and checked with
`verify-backup.sh`:

```text
checksum: OK
integrity=ok
tables=17
```

### Existing workloads

All existing systemd units remained active, the existing ports remained
present, `jisha` returned 200, and `miq` returned its expected 302 redirect.

## What was intentionally not done

### No broker migration

The separate `relay-router` tunnel spike remains outside this rollout. It has
a different EC2 instance (`i-0c23c6701070f68b3`) and was not mutated. The
broker still needs an intentional registry-config rollout and production work
for `wss://`, reconnect behavior, flow control, accept-time limits, metrics,
and graceful draining. Its raw protocols cannot simply be placed behind the
existing nginx HTTP layer.

### No runner migration

The existing agent runner on `pariksj-dev` was not moved. Its provider auth,
workspace jail, mTLS rules, and port 8787 remained untouched. If a future task
explicitly migrates it, preserve the exact Codex API mTLS subjects
`CN=iphone` and `CN=parikshit-mac` and keep direct Claude jobs free of AWS and
Bedrock environment variables.

### No iOS rebuild or endpoint cutover

No iOS files were changed, no Xcode build was made, and no device was
provisioned during this backend rollout. The currently dirty iOS/trial files in
the worktree belong to another effort. A future agent must deliberately point
the production account base URL at
`https://relay.ai-rocket-experiments.com`, then build/install and verify the
physical-phone account and node flows.

### No PostgreSQL claim

The shared EC2 already runs PostgreSQL for other apps, but Relay continues to
use `node:sqlite`. PostgreSQL support requires a real DAL/Better Auth adapter,
migrations, fixture tests, data reconciliation, cutover, rollback, and new
backup procedures. Do not point Relay at the existing PostgreSQL service and
call the migration complete.

## Commit and concurrent-work boundary

This workspace had an active concurrent trial/iOS session. While the
deployment was being verified, that session created checkpoint commit
`ca12db16df7438341bf617868d0713e1af3a91ae`. It included the deployment files
and initial deployment docs together with its trial, broker, relayd, and iOS
checkpoint. Follow-up commits `cdb6e87` and `d4d89b1` fixed the trial iOS target.

That combined checkpoint is historical fact; do not rewrite it or attribute
the trial/iOS code to this deployment task. Use the file inventory in this
document to identify the deployment-owned portion. The final release and
documentation corrections were validated after that checkpoint.

At the final documentation commit, the only unrelated worktree entry still
visible was untracked `.claude/settings.json`; it was intentionally left
untouched and uncommitted. Future agents must re-run `git status --short`
because another session can change the branch at any time.

## How the next agent should start

Run read-only checks first:

```bash
aws sts get-caller-identity --profile default
aws codepipeline list-pipeline-executions \
  --profile default --region ap-south-1 \
  --pipeline-name relay-cloud-deploy --max-results 5
curl -fsS https://relay.ai-rocket-experiments.com/healthz
dig +short A relay.ai-rocket-experiments.com
git status --short
```

Then use SSM, not SSH, to confirm the target release and listener. Never read
the secret values from `/etc/relay-cloud/env`; checking file ownership/mode or
the names of configured variables is enough.

Before a new deployment:

1. understand and isolate the intended source change;
2. run all 59 or more current cloud tests;
3. take an online SQLite backup for a schema-affecting release;
4. clone the standalone CodeCommit repository to a clean temporary directory;
5. overlay only reviewed service files;
6. push without force;
7. wait for the exact-SHA pipeline execution;
8. verify target, public, database, backup, and co-hosted applications.

## Remaining prioritized work

1. Update the iOS account base URL and perform a physical-device auth/pairing
   test over Wi-Fi and cellular.
2. Configure and live-test Sign in with Apple, APNs, and mail transport using
   an approved secret path; never put key material into CodeCommit or pipeline
   variables.
3. Add external uptime/error alerting and structured application logs.
4. Finish and separately deploy the broker production transport, including
   safe shared-ingress architecture.
5. Connect the runner/node to the cloud registry and signed node-event path
   without moving provider credentials into the control plane.
6. Exercise the trial provisioner against an actual Cube/E2B host only after
   its separate infrastructure and secret decisions are approved.
7. Decide whether PostgreSQL is warranted; if so, treat it as a tested
   migration project rather than an infrastructure toggle.

## Completion standard for future agents

Do not report a Relay cloud deployment complete until all are true:

- the requested AWS account/profile is re-verified;
- CodePipeline succeeded for the intended SHA;
- the target `current` symlink matches that SHA;
- the service is active and listens only on loopback 8790;
- public TLS health is 200;
- authenticated behavior works and privileged unauthenticated routes fail;
- SQLite integrity and permissions pass;
- a recent backup exists and a disposable restore verifies;
- nginx syntax passes;
- pre-existing shared-host apps remain healthy;
- no secrets or unrelated dirty-worktree changes were committed;
- the handoff states whether iOS, broker, runner, and static POCs were or were
  not changed.
