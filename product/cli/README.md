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
relay handoff
```

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
git tag relay-cli-v0.1.1
git push origin relay-cli-v0.1.1
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
