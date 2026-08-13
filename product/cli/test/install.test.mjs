import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cliRoot = fileURLToPath(new URL("..", import.meta.url));
const installScript = path.join(cliRoot, "dist", "install.sh");
const releasePublicKey = path.join(cliRoot, "dist", "release-public-key.pem");
const buildScript = path.join(cliRoot, "scripts", "build-release.sh");
const signScript = path.join(cliRoot, "scripts", "sign-release.mjs");

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, options);
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("the installer pins the reviewed Relay release public key", () => {
  const source = fs.readFileSync(installScript, "utf8");
  const match = source.match(/release_public_key='(-----BEGIN PUBLIC KEY-----[\s\S]+?-----END PUBLIC KEY-----)'/);
  assert.ok(match, "installer must embed a PEM public key");

  const reviewed = fs.readFileSync(releasePublicKey, "utf8").trim();
  assert.equal(match[1], reviewed);

  const der = crypto.createPublicKey(reviewed).export({ type: "spki", format: "der" });
  assert.equal(
    crypto.createHash("sha256").update(der).digest("hex"),
    "1348607d18ade24d12957e72745292e289e6703762426f684f022ff7ad5722c6",
  );
});

test("release signer emits an Ed25519 signature verifiable by its public key", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-sign-"));
  const archive = path.join(root, "release.tgz");
  const signature = `${archive}.sig`;
  fs.writeFileSync(archive, crypto.randomBytes(1024));

  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const privatePem = privateKey.export({ type: "pkcs8", format: "pem" });
  const signed = spawnSync(process.execPath, [signScript, archive, signature], {
    encoding: "utf8",
    env: {
      ...process.env,
      RELAY_CLI_SIGNING_KEY_B64: Buffer.from(privatePem).toString("base64"),
    },
  });
  assert.equal(signed.status, 0, signed.stderr);

  const encoded = fs.readFileSync(signature, "utf8").trim();
  assert.equal(
    crypto.verify(null, fs.readFileSync(archive), publicKey, Buffer.from(encoded, "base64")),
    true,
  );
});

test("curl-style installer verifies the signature and links the current CLI", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-install-"));
  const artifacts = path.join(root, "artifacts");
  const home = path.join(root, "home");
  const binDir = path.join(home, "bin");
  fs.mkdirSync(artifacts, { recursive: true });
  fs.mkdirSync(home, { recursive: true });

  const built = spawnSync("bash", [buildScript, artifacts], { cwd: cliRoot, encoding: "utf8" });
  assert.equal(built.status, 0, built.stderr);
  const version = fs.readFileSync(path.join(artifacts, "latest.txt"), "utf8").trim();
  const artifactName = `relay-cli-v${version}.tgz`;
  const artifactPath = path.join(artifacts, artifactName);
  const signaturePath = `${artifactPath}.sig`;

  // The production private key is deliberately unavailable to tests. Create a
  // one-test trust root and patch only the temporary installer copy.
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const publicPem = publicKey.export({ type: "spki", format: "pem" }).trim();
  const source = fs.readFileSync(installScript, "utf8");
  const testInstallerSource = source.replace(
    /release_public_key='-----BEGIN PUBLIC KEY-----[\s\S]+?-----END PUBLIC KEY-----'/,
    `release_public_key='${publicPem}'`,
  );
  assert.notEqual(testInstallerSource, source);
  const testInstaller = path.join(root, "install.sh");
  fs.writeFileSync(testInstaller, testInstallerSource, { mode: 0o755 });

  const signature = crypto.sign(null, fs.readFileSync(artifactPath), privateKey);
  fs.writeFileSync(signaturePath, `${signature.toString("base64")}\n`);

  const server = http.createServer((req, res) => {
    const files = new Map([
      ["/latest.txt", path.join(artifacts, "latest.txt")],
      [`/releases/v${version}/${artifactName}`, path.join(artifacts, artifactName)],
      [`/releases/v${version}/${artifactName}.sha256`, path.join(artifacts, `${artifactName}.sha256`)],
      [`/releases/v${version}/${artifactName}.sig`, signaturePath],
    ]);
    const source = files.get(req.url);
    if (!source) {
      res.writeHead(404).end();
      return;
    }
    fs.createReadStream(source).pipe(res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const address = server.address();
  const result = await run("sh", [testInstaller], {
    cwd: root,
    env: {
      ...process.env,
      HOME: home,
      RELAY_BIN_DIR: binDir,
      RELAY_INSTALL_ALLOW_HTTP: "1",
      RELAY_INSTALL_BASE_URL: `http://127.0.0.1:${address.port}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Verified Ed25519 release signature/);
  assert.match(result.stdout, new RegExp(`Installed Relay CLI ${version}`));

  const relayBin = path.join(binDir, "relay");
  assert.equal(fs.lstatSync(relayBin).isSymbolicLink(), true);
  const versionResult = spawnSync(relayBin, ["--version"], { encoding: "utf8" });
  assert.equal(versionResult.status, 0, versionResult.stderr);
  assert.equal(versionResult.stdout.trim(), version);

  // A same-origin attacker can replace both the archive and SHA-256 file. The
  // pinned key must still reject the substituted archive before extraction.
  fs.appendFileSync(artifactPath, "attacker-controlled bytes");
  const attackerChecksum = crypto.createHash("sha256").update(fs.readFileSync(artifactPath)).digest("hex");
  fs.writeFileSync(path.join(artifacts, `${artifactName}.sha256`), `${attackerChecksum}  ${artifactName}\n`);
  const attackedHome = path.join(root, "attacked-home");
  const attacked = await run("sh", [testInstaller], {
    cwd: root,
    env: {
      ...process.env,
      HOME: attackedHome,
      RELAY_BIN_DIR: path.join(attackedHome, "bin"),
      RELAY_INSTALL_ALLOW_HTTP: "1",
      RELAY_INSTALL_BASE_URL: `http://127.0.0.1:${address.port}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.notEqual(attacked.code, 0);
  assert.match(attacked.stderr, /Release signature verification failed/);
  assert.equal(fs.existsSync(path.join(attackedHome, "bin", "relay")), false);
});
