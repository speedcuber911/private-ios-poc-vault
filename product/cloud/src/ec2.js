// Minimal EC2 Query client for Start/Stop/Describe. Three actions, SigV4,
// no SDK. Injectable fetch + credentials so tests never touch AWS.
//
// Live credentials: AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / optional
// AWS_SESSION_TOKEN, else IMDSv2 on the control-plane host. The instance
// role on poc-ec2 must be scoped to the allowlisted instance ARNs — this
// module does not widen that.

import { createHash, createHmac } from "node:crypto";

const IMDS = "http://169.254.169.254";
const IMDS_TIMEOUT_MS = 1500;

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key, value) {
  return createHmac("sha256", key).update(value).digest();
}

function amzDate(now) {
  return new Date(now).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function canonicalQuery(params) {
  return Object.keys(params)
    .sort()
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`)
    .join("&");
}

function signingKey(secret, date, region, service) {
  const kDate = hmac(`AWS4${secret}`, date);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

function signV4({ method, host, path, query, headers, payload, region, service, credentials, now }) {
  const datetime = amzDate(now);
  const date = datetime.slice(0, 8);
  const payloadHash = sha256Hex(payload);
  const signedHeaderNames = Object.keys(headers)
    .map((name) => name.toLowerCase())
    .sort();
  const canonicalHeaders = signedHeaderNames
    .map((name) => {
      const original = Object.keys(headers).find((key) => key.toLowerCase() === name);
      return `${name}:${String(headers[original]).trim()}\n`;
    })
    .join("");
  const signedHeaders = signedHeaderNames.join(";");
  const canonical = [
    method,
    path,
    query,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const credentialScope = `${date}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    datetime,
    credentialScope,
    sha256Hex(canonical),
  ].join("\n");
  const signature = createHmac("sha256", signingKey(credentials.secretAccessKey, date, region, service))
    .update(stringToSign)
    .digest("hex");
  return {
    datetime,
    authorization:
      `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${credentialScope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

function parseInstanceStates(xml) {
  const instances = [];
  const blocks = String(xml).split(/<item>/i).slice(1);
  for (const block of blocks) {
    const id = /<instanceId>\s*(i-[0-9a-f]+)\s*<\/instanceId>/i.exec(block);
    const state = /<(?:currentState|instanceState)>[\s\S]*?<name>\s*([a-z-]+)\s*<\/name>/i.exec(block);
    if (id) {
      instances.push({ instanceId: id[1].toLowerCase(), state: state ? state[1] : "unknown" });
    }
  }
  return instances;
}

async function fetchText(fetchImpl, url, init, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { ...init, signal: ac.signal });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text };
  } finally {
    clearTimeout(timer);
  }
}

async function loadImdsCredentials(fetchImpl) {
  const tokenRes = await fetchText(
    fetchImpl,
    `${IMDS}/latest/api/token`,
    {
      method: "PUT",
      headers: { "x-aws-ec2-metadata-token-ttl-seconds": "21600" },
    },
    IMDS_TIMEOUT_MS,
  );
  if (!tokenRes.ok || !tokenRes.text.trim()) throw new Error("imds_token");
  const token = tokenRes.text.trim();
  const roleRes = await fetchText(
    fetchImpl,
    `${IMDS}/latest/meta-data/iam/security-credentials/`,
    { headers: { "x-aws-ec2-metadata-token": token } },
    IMDS_TIMEOUT_MS,
  );
  const role = roleRes.text.trim().split("\n")[0];
  if (!roleRes.ok || !role) throw new Error("imds_role");
  const credsRes = await fetchText(
    fetchImpl,
    `${IMDS}/latest/meta-data/iam/security-credentials/${role}`,
    { headers: { "x-aws-ec2-metadata-token": token } },
    IMDS_TIMEOUT_MS,
  );
  if (!credsRes.ok) throw new Error("imds_creds");
  const parsed = JSON.parse(credsRes.text);
  if (!parsed.AccessKeyId || !parsed.SecretAccessKey) throw new Error("imds_creds");
  return {
    accessKeyId: parsed.AccessKeyId,
    secretAccessKey: parsed.SecretAccessKey,
    sessionToken: parsed.Token || null,
  };
}

async function envOrImdsCredentials(fetchImpl) {
  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    return {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      sessionToken: process.env.AWS_SESSION_TOKEN || null,
    };
  }
  return loadImdsCredentials(fetchImpl);
}

function instanceParams(action, instanceIds) {
  const params = { Action: action, Version: "2016-11-15" };
  instanceIds.forEach((id, index) => {
    params[`InstanceId.${index + 1}`] = id;
  });
  return params;
}

export function createEc2Client({
  region,
  fetchImpl = fetch,
  credentials,
  now = () => Date.now(),
} = {}) {
  if (!region) throw new TypeError("createEc2Client requires region");

  async function call(action, instanceIds) {
    const creds = credentials || (await envOrImdsCredentials(fetchImpl));
    const host = `ec2.${region}.amazonaws.com`;
    const payload = canonicalQuery(instanceParams(action, instanceIds));
    const headers = {
      host,
      "content-type": "application/x-www-form-urlencoded; charset=utf-8",
      "x-amz-date": amzDate(now()),
    };
    if (creds.sessionToken) headers["x-amz-security-token"] = creds.sessionToken;
    const signed = signV4({
      method: "POST",
      host,
      path: "/",
      query: "",
      headers,
      payload,
      region,
      service: "ec2",
      credentials: creds,
      now: now(),
    });
    headers.authorization = signed.authorization;
    headers["x-amz-date"] = signed.datetime;
    const res = await fetchImpl(`https://${host}/`, {
      method: "POST",
      headers,
      body: payload,
    });
    const text = await res.text();
    if (!res.ok) {
      const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1] || `http_${res.status}`;
      throw Object.assign(new Error(`ec2_${code}`), { status: res.status, body: text });
    }
    return { instances: parseInstanceStates(text) };
  }

  return {
    startInstances: ({ instanceIds }) => call("StartInstances", instanceIds),
    stopInstances: ({ instanceIds }) => call("StopInstances", instanceIds),
    describeInstances: ({ instanceIds }) => call("DescribeInstances", instanceIds),
  };
}

export { parseInstanceStates, amzDate };
