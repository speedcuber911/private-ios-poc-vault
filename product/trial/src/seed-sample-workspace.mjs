// A real, explicitly preloaded example. No provider invocation or credentials.
// Run once before relayd loads its store; never overwrite a user's workspace.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const jobId = "03555a49-f9f0-45d4-95b2-41f3e7a0b59a";

export async function seedSampleWorkspace({ dataDir, workspaceRoot, htmlPath, store }) {
  const marker = path.join(dataDir, "starter-sample-v1");
  if (fs.existsSync(marker)) return { status: "already_seeded", jobId };
  const workspacePath = path.join(workspaceRoot, "Launch checklist");
  // Existing content belongs to the user, even when its name matches ours.
  if (fs.existsSync(workspacePath)) return { status: "workspace_exists", jobId: null };
  if (store.loadJobRecords().some(({ job }) => job?.id === jobId)) {
    return { status: "job_exists", jobId };
  }
  const html = fs.readFileSync(htmlPath);
  if (html.length > 1024 * 1024) throw new Error("starter_sample_too_large");
  const artifactDir = path.join(dataDir, "artifacts", jobId);
  const logsDir = path.join(dataDir, "logs");
  fs.mkdirSync(workspaceRoot, { recursive: true, mode: 0o750 });
  fs.mkdirSync(workspacePath, { mode: 0o750 });
  fs.mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(logsDir, { recursive: true, mode: 0o700 });
  const artifactPath = path.join(artifactDir, "artifact-001-launch-checklist.html");
  fs.writeFileSync(path.join(workspacePath, "launch-checklist.html"), html, { flag: "wx", mode: 0o640 });
  fs.writeFileSync(artifactPath, html, { flag: "wx", mode: 0o600 });
  fs.writeFileSync(path.join(workspacePath, "README.md"), [
    "# Launch checklist — preloaded example", "",
    "Relay includes this fictional starter project to demonstrate files, task context and previews.",
    "It is not a record of an AI provider run. No prompt, personal data or provider credentials were sent.",
    "Open Previews > Workspace results to inspect the HTML artifact or the working local app.",
    "The local preview server listens only on 127.0.0.1:4317; Relay opens it through authenticated task-linked access.",
    "Connect your own provider account to start real agent tasks. You can edit or remove this sample workspace.", "",
  ].join("\n"), { flag: "wx", mode: 0o640 });
  const result = [
    "## Preloaded example: Launch checklist", "",
    "This fictional starter project was supplied with Relay. It is not an AI-generated run; no provider call was made.",
    "Inspect the HTML artifact, check the three interactive release controls, or browse this workspace's source files.", "",
    "Open the working sample: `http://localhost:4317/lab`", "",
    "To create your own results, connect an AI provider and start a new task in your workspace.",
  ].join("\n");
  const now = new Date().toISOString();
  const job = {
    id: jobId, status: "succeeded", provider: "codex", model: "Preloaded example — no AI call",
    workspaceId: "dir-launch-checklist", workspaceName: "Launch checklist",
    workspacePath, prompt: "Preloaded example: inspect the launch checklist", codexPrompt: "",
    createdAt: now, updatedAt: now, startedAt: null, finishedAt: now,
    durationMs: null, exitCode: null, timedOut: false, error: null,
    certSubject: "Relay starter example", timeoutMs: 0, execution: null,
    skills: [], skillInputs: [], attachments: [], sessionId: null, resumeSessionId: null,
    reasoningEffort: null, permissionMode: null, approvalPolicy: null,
    stdoutPath: path.join(logsDir, `${jobId}.stdout.log`),
    stderrPath: path.join(logsDir, `${jobId}.stderr.log`),
    resultPath: path.join(logsDir, `${jobId}.answer.md`), result,
    sampleOrigin: "relay-starter-v1",
    artifacts: [{
      id: "artifact-001", kind: "staticPreview", filename: "launch-checklist.html",
      title: "Launch checklist — sample", language: "html", contentType: "text/html; charset=utf-8",
      bytes: html.length, path: artifactPath,
      rawURL: `/v1/codex/jobs/${jobId}/artifacts/artifact-001/raw`,
      previewURL: `/v1/codex/jobs/${jobId}/artifacts/artifact-001/preview`,
    }],
  };
  fs.writeFileSync(job.stdoutPath, "", { flag: "wx", mode: 0o600 });
  fs.writeFileSync(job.stderrPath, "", { flag: "wx", mode: 0o600 });
  fs.writeFileSync(job.resultPath, result, { flag: "wx", mode: 0o600 });
  store.saveJob(job);
  fs.writeFileSync(marker, `${jobId}\n`, { flag: "wx", mode: 0o600 });
  return { status: "seeded", jobId };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const dataDir = process.env.CODEX_DATA_DIR || "/var/lib/relayd";
  const workspaceRoot = process.env.CODEX_WORKSPACE_BROWSE_ROOT || "/srv/relay-workspaces";
  const root = path.dirname(fileURLToPath(import.meta.url));
  const { store } = await import("/opt/relayd/app/src/store.mjs");
  try {
    console.log(JSON.stringify(await seedSampleWorkspace({
      dataDir, workspaceRoot, htmlPath: path.join(root, "../sample/launch-checklist.html"), store,
    })));
  } finally { store.close?.(); }
}
