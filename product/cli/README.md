# Relay CLI

The Relay CLI hands a local Claude Code or Codex session to the Relay sandbox
connected to the iOS app. It requires macOS or Linux, Node.js 20 or newer, Git,
and a GitHub remote for repository handoffs.

## Install

After the infrastructure owner deploys the download distribution:

```bash
curl --proto '=https' --tlsv1.2 -fsSL \
  https://get.openrelay.sh/install.sh | sh
```

This is a per-user install. The versioned package lands under
`~/.local/share/relay`, and `~/.local/bin/relay` points at the current version.
The installer never uses `sudo`, refuses to replace an unrelated `relay`
executable, and verifies the release archive against its published SHA-256.
It also verifies a detached Ed25519 signature over the exact archive bytes
against the public key embedded in `install.sh`; a substituted archive and
same-origin checksum therefore fail closed before extraction.

If `~/.local/bin` is not already on `PATH`, add it to the shell profile before
running:

```bash
relay login
relay init
relay install-skill
relay handoff
```

## Commands

`relay install-skill` installs the shared `relay-handoff` Agent Skill into the
user-level skill directories for Codex, Claude Code, Cursor, and Kimi Code.
After starting a new agent session, phrases such as “handoff to Relay”, “send
this to Relay”, or “continue this on my phone” trigger the workflow. The skill
drives the existing CLI commands; it does not add an MCP server or copy agent
settings, plugins, skills, or slash commands to the Relay runner. Re-run with
`--force` only when intentionally replacing a locally modified copy.

`relay login` signs in and pins the sandbox this machine hands off to. Approve
the device code by scanning the QR in the iOS app. The production control plane
is compiled in, so no environment variable is needed; `RELAY_CLOUD_URL`
overrides it for development.

A login **replaces** this machine's identity rather than merging into it. The
pinned machine is always cleared first and re-derived from the newly signed-in
account, so a stale pin can never outlive the account it belonged to. If the
approving account differs from the one this machine used before, `relay login`
says so explicitly — approval is anonymous by construction, so whoever scans
the QR is who this CLI becomes, and that must never happen quietly. The iOS app
shows a confirm sheet naming the machine before approving, so check the machine
name matches the terminal you are sitting at.

`relay init` registers the current repository for handoffs. A repository that
was never registered is rejected by `relay handoff` up front, before anything
is pushed.

`relay sync-auth` copies this machine's GitHub and harness logins to the
sandbox, sealed to the node's key. Credentials ride the pairing rendezvous as
opaque bytes; the control plane relays them without being able to read them,
and they never touch GitHub. What it looks for:

| harness | source |
| --- | --- |
| GitHub | `gh auth token` |
| Claude Code | `~/.claude/.credentials.json`, or — on macOS — the login Keychain item `Claude Code-credentials` |
| Codex | `~/.codex/auth.json` |
| Cursor | no portable login exists; sign in on the sandbox itself |
| Kimi Code | `$KIMI_CODE_HOME` or `~/.kimi-code` OAuth credentials plus the generated provider/model config |

The Keychain lookup matters on macOS: Claude Code stores its login there and
**not** in `~/.claude/.credentials.json`, which is the Linux location. Reading
only the file meant a signed-in Mac reported "No Claude Code login found" and
the sandbox came up with no Anthropic credential. Anything not found is named
in the output rather than silently omitted — this command never reports a
credential it did not actually send.

`relay handoff` seals the current session, pushes it to a `relay/handoff-*`
branch, tells the cloud, then **waits for the sandbox to finish importing it**
before exiting. It reports the terminal state rather than assuming success:

| result | exit code | meaning |
| --- | --- | --- |
| `ready` | 0 | the sandbox cloned, decrypted and imported the session |
| `failed` | 1 | the sandbox could not open it; the reason is printed |
| still pending after 120s | 0 | recorded but not yet collected — check `relay status` |

`delivered` is deliberately not treated as success: the sandbox acks the row
before the import runs, so it means only "it was collected". Use `--no-push` to
prepare the branch locally without contacting the cloud, and `--session <id>`
to hand off a session other than the most recent.

`relay status` lists this repository's handoffs and their states.

Progress is written to **stderr**, so piping `relay status` stays clean. Without
a TTY it degrades to one line per step instead of a spinner, so CI logs still
show which step ran — and which one it died on.

## Distribution model

```text
Route 53 -> CloudFront -> private, versioned S3 bucket
                            ├── install.sh
                            ├── release-public-key.pem
                            ├── latest.txt
                            └── releases/v<version>/{archive,checksum,signature}
```

`deploy/distribution.yml` owns the AWS resources in `us-east-1`, including the
CloudFront TLS certificate and a tag-scoped GitHub Actions OIDC role. No AWS
access key is stored in GitHub. Immutable releases are cached for one year;
`install.sh` and `latest.txt` are not cached.

The release publisher can write versioned releases and `latest.txt`, but cannot
overwrite `install.sh` or its pinned public key. The private Ed25519 signing key
never enters this repository or AWS. The reviewed public-key fingerprint is:

```text
SHA-256 1348607d18ade24d12957e72745292e289e6703762426f684f022ff7ad5722c6
```

This signature protects release archives if the download origin or publisher
role is compromised. Like every `curl | sh` bootstrap, it cannot protect a
first-time user if an attacker can replace the installer itself; users with a
high-risk threat model should inspect `install.sh` from the source repository
and compare its embedded-key fingerprint before executing it.

## Provision in the intended AWS account

Do not deploy with ambient credentials. Select the intended account explicitly,
verify it with `aws sts get-caller-identity`, and provide that account's hosted
zone and GitHub OIDC provider:

```bash
export AWS_PROFILE=<intended-profile>
export AWS_REGION=us-east-1
export RELAY_CLI_EXPECTED_AWS_ACCOUNT_ID=<12-digit-account-id>
export RELAY_CLI_DISTRIBUTION_DOMAIN=get.relay.example.com
export RELAY_CLI_HOSTED_ZONE_ID=<hosted-zone-id>
export RELAY_CLI_GITHUB_OIDC_PROVIDER_ARN=<provider-arn>
product/cli/deploy/bootstrap.sh
```

The script compares the active STS account with
`RELAY_CLI_EXPECTED_AWS_ACCOUNT_ID` before it can create or change anything.

The bootstrap prints the two GitHub Actions variables to configure:
`RELAY_CLI_PUBLISH_ROLE_ARN` and `RELAY_CLI_AWS_REGION`. It uploads the reviewed
installer and public key once using the infrastructure owner's identity. The
tag-scoped GitHub role created by the stack cannot change those two trust-root
objects.

The release-key holder must separately configure the repository secret
`RELAY_CLI_SIGNING_KEY_B64` from the private PKCS#8 Ed25519 key. Do not send the
key to the AWS infrastructure owner merely because they deploy the bucket.

## Release

Update `package.json`, commit the change, and tag that commit:

```bash
git tag relay-cli-v0.1.2
git push origin relay-cli-v0.1.2
```

`.github/workflows/release-relay-cli.yml` requires the tag to match the package
version, runs the complete CLI test suite, assumes the narrow AWS publisher role
through GitHub OIDC, signs the archive, then uploads the archive, checksum,
detached signature, and latest pointer. It refuses to replace an existing
version with different bytes.

An operator with the same narrow AWS access can publish explicitly with:

```bash
product/cli/deploy/publish.sh
```

Local signing defaults to the private key at
`~/.poc-vault/secrets/signing/relay-cli-ed25519.key`, or accepts
`RELAY_CLI_SIGNING_KEY_FILE`/`RELAY_CLI_SIGNING_KEY_B64`. The corresponding
public key is safe and intentionally committed; the private key is not.
