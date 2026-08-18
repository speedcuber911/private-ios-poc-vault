// relayd artifacts.mjs — extracted verbatim from relay-server/codex-api-deploy/server.mjs (W2-CORE, behavior-preserving).
import http from "node:http";
import https from "node:https";
import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { artifactsDir, maxJobArtifacts, maxArtifactBytes, maxArtifactTotalBytes, cleanDisplayName, cleanOptionalFilePath } from "./config.mjs";
import { sendHtml, sendBytes, sendError, cleanApiText } from "./util.mjs";
import { jobs } from "./jobs.mjs";

function isSafeArtifactId(id) {
  return /^artifact-[0-9]{3}$/.test(id);
}


function extractJobArtifacts(job, answerText) {
  if (maxJobArtifacts <= 0 || !answerText) return [];
  const blocks = parseMarkdownCodeBlocks(answerText);

  const jobArtifactsDir = path.join(artifactsDir, job.id);
  const saved = [];
  let totalBytes = 0;

  for (const block of blocks) {
    if (saved.length >= maxJobArtifacts) break;
    const content = cleanArtifactContent(block.content);
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes === 0 || bytes > maxArtifactBytes || totalBytes + bytes > maxArtifactTotalBytes) continue;

    const ordinal = saved.length + 1;
    const parsed = parseFenceInfo(block.info);
    const filename = safeArtifactFilename(parsed.filename, parsed.language, ordinal);
    const language = parsed.language || languageForFilename(filename);
    const artifact = writeJobArtifact({
      job,
      ordinal,
      filename,
      language,
      content,
      kind: kindForArtifact(filename, language),
    });
    saved.push({ artifact, content });
    totalBytes += bytes;
  }

  const assembled = assembleStaticPreviewArtifact(job, saved, totalBytes);
  if (assembled) {
    saved.push(assembled);
    totalBytes += assembled.artifact.bytes;
  }

  for (const filePath of referencedArtifactPaths(job, answerText)) {
    if (saved.length >= maxJobArtifacts) break;
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size <= 0 || stat.size > maxArtifactBytes || totalBytes + stat.size > maxArtifactTotalBytes) continue;
    const ordinal = saved.length + 1;
    const filename = safeArtifactFilename(path.basename(filePath), languageForFilename(filePath), ordinal);
    if (hasBlockedArtifactFilename(filename)) continue;
    const artifact = copyJobArtifact({ job, ordinal, filename, sourcePath: filePath });
    saved.push({ artifact, content: null });
    totalBytes += stat.size;
  }

  if (!saved.length) {
    removeArtifactDirectory(jobArtifactsDir);
    return [];
  }

  return saved.map((entry) => entry.artifact);
}

const referencedArtifactExtensions = new Set([
  "pdf", "csv", "tsv", "xlsx", "xls", "ods", "docx", "doc", "odt", "pptx", "ppt", "rtf",
  "png", "jpg", "jpeg", "gif", "webp", "heic", "svg", "html", "htm", "md", "txt", "json",
  "zip", "tar", "gz", "tgz", "mp3", "wav", "m4a", "mp4", "mov",
]);

function referencedArtifactPaths(job, answerText) {
  let root = path.resolve(job.worktree?.path || job.workspacePath || "");
  try { root = fs.realpathSync(root); } catch { return []; }
  if (!root || root === path.parse(root).root) return [];
  const candidates = [];
  const text = String(answerText || "");
  for (const pattern of [
    /\[[^\]]*\]\(([^)]+)\)/g,
    /`([^`\r\n]+)`/g,
  ]) {
    for (const match of text.matchAll(pattern)) candidates.push(match[1]);
  }

  const resolved = [];
  const seen = new Set();
  for (let candidate of candidates) {
    candidate = String(candidate || "").trim().replace(/^<|>$/g, "").replace(/^file:\/\//i, "");
    candidate = candidate.replace(/\s+["'][^"']*["']$/, "");
    try { candidate = decodeURIComponent(candidate); } catch { /* keep the literal path */ }
    if (!candidate || /^[a-z][a-z0-9+.-]*:/i.test(candidate)) continue;
    const extension = path.extname(candidate).slice(1).toLowerCase();
    if (!referencedArtifactExtensions.has(extension)) continue;
    const absolute = path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(root, candidate);
    let real;
    try { real = fs.realpathSync(absolute); } catch { continue; }
    const relative = path.relative(root, real);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || seen.has(real)) continue;
    seen.add(real);
    resolved.push(real);
  }
  return resolved;
}


function parseMarkdownCodeBlocks(text) {
  const blocks = [];
  const lines = String(text).split(/\r?\n/);
  let current = null;

  for (const line of lines) {
    const fence = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (!fence) {
      if (current) current.lines.push(line);
      continue;
    }

    const marker = fence[1][0];
    if (!current) {
      current = { marker, length: fence[1].length, info: fence[2].trim(), lines: [] };
      continue;
    }

    if (marker === current.marker && fence[1].length >= current.length) {
      blocks.push({ info: current.info, content: current.lines.join("\n") });
      current = null;
    } else {
      current.lines.push(line);
    }
  }

  return blocks;
}


function parseFenceInfo(info) {
  const tokens = String(info || "").trim().split(/\s+/).filter(Boolean);
  let language = "";
  let filename = "";

  for (const token of tokens) {
    const keyValue = token.match(/^(?:file|filename|path|name)=([^=]+)$/i);
    if (keyValue && !filename) {
      filename = stripFenceQuotes(keyValue[1]);
      continue;
    }

    if (!language && looksLikeFilename(token)) {
      filename ||= stripFenceQuotes(token);
      language = languageForFilename(filename);
      continue;
    }

    if (!language) {
      language = cleanArtifactLanguage(token);
      continue;
    }

    if (!filename && looksLikeFilename(token)) {
      filename = stripFenceQuotes(token);
    }
  }

  return { language, filename };
}


function stripFenceQuotes(value) {
  const trimmed = String(value || "").trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}


function looksLikeFilename(value) {
  const raw = stripFenceQuotes(value);
  return /[./\\]/.test(raw) || /^[A-Za-z0-9_-]+\.[A-Za-z0-9._-]+$/.test(raw);
}


function cleanArtifactLanguage(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9#+._-]/g, "")
    .slice(0, 40);
}


function cleanArtifactContent(value) {
  return cleanApiText(value || "").replace(/\s+$/, "");
}


function safeArtifactFilename(value, language, ordinal) {
  const fallback = `artifact-${String(ordinal).padStart(3, "0")}${extensionForLanguage(language)}`;
  const raw = stripFenceQuotes(value);
  if (!raw || raw.includes("/") || raw.includes("\\") || raw.includes("..")) return fallback;
  const cleaned = raw
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  if (!cleaned || cleaned === "." || cleaned === ".." || cleaned.startsWith(".")) return fallback;
  if (hasBlockedArtifactFilename(cleaned)) return fallback;
  return path.extname(cleaned) ? cleaned : `${cleaned}${extensionForLanguage(language)}`;
}


function hasBlockedArtifactFilename(filename) {
  const lower = filename.toLowerCase();
  return [".env", ".pem", ".key", ".p12", ".crt", ".csr", ".mobileconfig"].some((suffix) => lower.endsWith(suffix));
}


function extensionForLanguage(language) {
  switch (cleanArtifactLanguage(language)) {
    case "html":
    case "htm":
      return ".html";
    case "css":
      return ".css";
    case "javascript":
    case "js":
    case "jsx":
      return ".js";
    case "typescript":
    case "ts":
      return ".ts";
    case "tsx":
      return ".tsx";
    case "json":
      return ".json";
    case "svg":
      return ".svg";
    case "markdown":
    case "md":
      return ".md";
    case "python":
    case "py":
      return ".py";
    case "swift":
      return ".swift";
    case "bash":
    case "sh":
    case "shell":
      return ".sh";
    case "text":
    case "txt":
      return ".txt";
    case "csv":
      return ".csv";
    case "tsv":
      return ".tsv";
    default:
      return ".txt";
  }
}


function languageForFilename(filename) {
  switch (path.extname(String(filename || "")).toLowerCase()) {
    case ".html":
    case ".htm":
      return "html";
    case ".css":
      return "css";
    case ".js":
    case ".mjs":
    case ".cjs":
      return "js";
    case ".jsx":
      return "jsx";
    case ".ts":
      return "ts";
    case ".tsx":
      return "tsx";
    case ".json":
      return "json";
    case ".svg":
      return "svg";
    case ".md":
    case ".markdown":
      return "markdown";
    case ".py":
      return "python";
    case ".swift":
      return "swift";
    case ".sh":
      return "bash";
    case ".txt":
      return "text";
    case ".csv":
      return "csv";
    case ".tsv":
      return "tsv";
    default:
      return "";
  }
}


function kindForArtifact(filename, language) {
  const normalized = cleanArtifactLanguage(language || languageForFilename(filename));
  const extension = path.extname(String(filename || "")).toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".heic"].includes(extension)) return "image";
  if ([".pdf", ".csv", ".tsv", ".xlsx", ".xls", ".ods", ".docx", ".doc", ".odt", ".pptx", ".ppt", ".rtf"].includes(extension)) return "document";
  if (["html", "htm", "svg"].includes(normalized)) return "staticPreview";
  if (["markdown", "md", "csv", "tsv"].includes(normalized)) return "document";
  return "code";
}


function contentTypeForArtifact(filename, language) {
  const normalized = cleanArtifactLanguage(language || languageForFilename(filename));
  const extension = path.extname(String(filename || "")).toLowerCase();
  const binaryType = {
    ".pdf": "application/pdf", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".xls": "application/vnd.ms-excel", ".ods": "application/vnd.oasis.opendocument.spreadsheet",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".doc": "application/msword",
    ".odt": "application/vnd.oasis.opendocument.text", ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".ppt": "application/vnd.ms-powerpoint", ".rtf": "application/rtf", ".png": "image/png", ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".heic": "image/heic",
    ".zip": "application/zip", ".tar": "application/x-tar", ".gz": "application/gzip", ".tgz": "application/gzip",
    ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".mp4": "video/mp4", ".mov": "video/quicktime",
  }[extension];
  if (binaryType) return binaryType;
  switch (normalized) {
    case "html":
    case "htm":
      return "text/html; charset=utf-8";
    case "css":
      return "text/css; charset=utf-8";
    case "javascript":
    case "js":
    case "jsx":
      return "text/javascript; charset=utf-8";
    case "json":
      return "application/json; charset=utf-8";
    case "svg":
      return "image/svg+xml; charset=utf-8";
    case "markdown":
    case "md":
      return "text/markdown; charset=utf-8";
    case "csv":
      return "text/csv; charset=utf-8";
    case "tsv":
      return "text/tab-separated-values; charset=utf-8";
    default:
      return "text/plain; charset=utf-8";
  }
}

function copyJobArtifact({ job, ordinal, filename, sourcePath }) {
  const id = `artifact-${String(ordinal).padStart(3, "0")}`;
  const jobArtifactsDir = path.join(artifactsDir, job.id);
  fs.mkdirSync(jobArtifactsDir, { recursive: true });
  const filePath = path.join(jobArtifactsDir, `${id}-${filename}`);
  fs.copyFileSync(sourcePath, filePath);
  const bytes = fs.statSync(filePath).size;
  const language = languageForFilename(filename);
  const kind = kindForArtifact(filename, language);
  return {
    id, kind, filename, title: titleForArtifact(filename), language: language || null,
    contentType: contentTypeForArtifact(filename, language), bytes, path: filePath,
    rawURL: artifactRoute(job.id, id, "raw"),
    previewURL: isPreviewableArtifact(filename, language, kind) ? artifactRoute(job.id, id, "preview") : null,
  };
}


function writeJobArtifact({ job, ordinal, filename, language, content, kind }) {
  const id = `artifact-${String(ordinal).padStart(3, "0")}`;
  const jobArtifactsDir = path.join(artifactsDir, job.id);
  fs.mkdirSync(jobArtifactsDir, { recursive: true });
  const filePath = path.join(jobArtifactsDir, `${id}-${filename}`);
  fs.writeFileSync(filePath, content, "utf8");
  const bytes = Buffer.byteLength(content, "utf8");
  return {
    id,
    kind,
    filename,
    title: titleForArtifact(filename),
    language: language || null,
    contentType: contentTypeForArtifact(filename, language),
    bytes,
    path: filePath,
    rawURL: artifactRoute(job.id, id, "raw"),
    previewURL: isPreviewableArtifact(filename, language, kind) ? artifactRoute(job.id, id, "preview") : null,
  };
}


function titleForArtifact(filename) {
  return String(filename || "Artifact").replace(/[-_]+/g, " ");
}


function isPreviewableArtifact(filename, language, kind) {
  if (kind === "staticPreview") return true;
  const normalized = cleanArtifactLanguage(language || languageForFilename(filename));
  if (!normalized) return false;
  return contentTypeForArtifact(filename, normalized).startsWith("text/")
    || ["json", "javascript", "js", "jsx"].includes(normalized);
}


function artifactRoute(jobId, artifactId, mode) {
  return `/v1/codex/jobs/${jobId}/artifacts/${artifactId}/${mode}`;
}


function assembleStaticPreviewArtifact(job, saved, totalBytes) {
  if (saved.length >= maxJobArtifacts) return null;
  const html = saved.find((entry) => ["html", "htm"].includes(cleanArtifactLanguage(entry.artifact.language || languageForFilename(entry.artifact.filename))));
  if (!html) return null;
  const cssBlocks = saved
    .filter((entry) => cleanArtifactLanguage(entry.artifact.language || languageForFilename(entry.artifact.filename)) === "css")
    .map((entry) => entry.content);
  const jsBlocks = saved
    .filter((entry) => ["js", "javascript"].includes(cleanArtifactLanguage(entry.artifact.language || languageForFilename(entry.artifact.filename))))
    .map((entry) => entry.content);
  if (!cssBlocks.length && !jsBlocks.length) return null;

  const content = assembleStaticHtml(html.content, cssBlocks, jsBlocks);
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > maxArtifactBytes || totalBytes + bytes > maxArtifactTotalBytes) return null;

  const ordinal = saved.length + 1;
  const artifact = writeJobArtifact({
    job,
    ordinal,
    filename: "preview.html",
    language: "html",
    content,
    kind: "staticPreview",
  });
  return { artifact, content };
}


function assembleStaticHtml(html, cssBlocks, jsBlocks) {
  let document = html.trim();
  if (!/<html[\s>]/i.test(document)) {
    document = `<!doctype html>\n<html>\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n</head>\n<body>\n${document}\n</body>\n</html>`;
  }

  const styles = cssBlocks.length ? `<style>\n${cssBlocks.join("\n\n")}\n</style>\n` : "";
  const scripts = jsBlocks.length ? `<script>\n${jsBlocks.join("\n\n")}\n</script>\n` : "";
  if (styles && /<\/head>/i.test(document)) {
    document = document.replace(/<\/head>/i, `${styles}</head>`);
  } else if (styles) {
    document = `${styles}${document}`;
  }
  if (scripts && /<\/body>/i.test(document)) {
    document = document.replace(/<\/body>/i, `${scripts}</body>`);
  } else if (scripts) {
    document = `${document}\n${scripts}`;
  }
  return document;
}


function sanitizePersistedArtifacts(job) {
  if (!Array.isArray(job?.artifacts)) return [];
  return job.artifacts
    .filter((artifact) => artifact && typeof artifact === "object")
    .map((artifact) => {
      const id = isSafeArtifactId(artifact.id) ? artifact.id : "";
      const filename = safeArtifactFilename(artifact.filename, artifact.language, Number(id.slice(-3)) || 1);
      const language = cleanArtifactLanguage(artifact.language || languageForFilename(filename));
      const kind = ["code", "staticPreview", "document", "image"].includes(artifact.kind) ? artifact.kind : kindForArtifact(filename, language);
      const filePath = cleanOptionalFilePath(artifact.path);
      if (!id || !filePath || !artifactPathBelongsToJob(job.id, filePath)) return null;
      const bytes = Number.isFinite(artifact.bytes) && artifact.bytes >= 0 ? artifact.bytes : 0;
      return {
        id,
        kind,
        filename,
        title: cleanDisplayName(artifact.title || titleForArtifact(filename), "artifact title", 120),
        language: language || null,
        contentType: contentTypeForArtifact(filename, language),
        bytes,
        path: filePath,
        rawURL: artifactRoute(job.id, id, "raw"),
        previewURL: isPreviewableArtifact(filename, language, kind) ? artifactRoute(job.id, id, "preview") : null,
      };
    })
    .filter(Boolean);
}


function publicArtifactResponses(job) {
  return sanitizePersistedArtifacts(job).map((artifact) => ({
    id: artifact.id,
    kind: artifact.kind,
    filename: artifact.filename,
    title: artifact.title,
    language: artifact.language,
    contentType: artifact.contentType,
    bytes: artifact.bytes,
    rawURL: artifact.rawURL,
    previewURL: artifact.previewURL,
  }));
}


function artifactPathBelongsToJob(jobId, filePath) {
  const root = path.resolve(path.join(artifactsDir, jobId));
  const resolved = path.resolve(filePath);
  const relative = path.relative(root, resolved);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}


function serveJobArtifact(res, job, artifactId, mode) {
  const artifact = sanitizePersistedArtifacts(job).find((entry) => entry.id === artifactId);
  if (!artifact || !artifact.path || !artifactPathBelongsToJob(job.id, artifact.path)) {
    return sendError(res, 404, "artifact not found");
  }

  let body;
  try {
    body = fs.readFileSync(artifact.path);
  } catch {
    return sendError(res, 404, "artifact not found");
  }

  if (mode === "raw") {
    return sendBytes(res, 200, body, {
      "content-type": artifact.contentType || "application/octet-stream",
      "content-disposition": `attachment; filename="${contentDispositionFilename(artifact.filename)}"`,
      "x-content-type-options": "nosniff",
    });
  }

  if (!artifact.previewURL) return sendError(res, 404, "artifact preview not available");
  return sendHtml(res, 200, artifactPreviewWrapper(artifact, body.toString("utf8")));
}


function contentDispositionFilename(filename) {
  return String(filename || "artifact.txt").replace(/["\r\n\\]/g, "-");
}


function artifactPreviewWrapper(artifact, rawContent) {
  const srcdoc = previewSrcdoc(artifact, rawContent);
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(artifact.title || artifact.filename)}</title>
  <style>
    html, body { height: 100%; margin: 0; background: #101113; color: #f5f5f0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 12px; border-bottom: 1px solid rgba(255,255,255,.12); background: #17181b; }
    strong { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    span { color: rgba(245,245,240,.62); font-size: 12px; }
    iframe { width: 100%; height: calc(100% - 42px); border: 0; background: white; display: block; }
  </style>
</head>
<body data-codex-artifact-preview="true">
  <header><strong>${escapeHtml(artifact.filename)}</strong><span>${escapeHtml(artifact.kind)}</span></header>
  <iframe sandbox="allow-scripts" referrerpolicy="no-referrer" srcdoc="${escapeHtmlAttribute(srcdoc)}"></iframe>
</body>
</html>`;
}


function previewSrcdoc(artifact, rawContent) {
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data:;">`;
  const language = cleanArtifactLanguage(artifact.language || languageForFilename(artifact.filename));
  if (language === "markdown" || language === "md") {
    return `<!doctype html><html><head><meta charset="utf-8">${csp}<style>body{font:14px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.5;margin:24px;color:#202124}pre{white-space:pre-wrap;word-break:break-word}</style></head><body><pre>${escapeHtml(rawContent)}</pre></body></html>`;
  }
  if (language === "csv" || language === "tsv") {
    const delimiter = language === "tsv" ? "\t" : ",";
    return delimitedPreviewSrcdoc(rawContent, delimiter);
  }
  if (language === "svg") {
    return `<!doctype html><html><head><meta charset="utf-8">${csp}<style>body{margin:0;display:grid;place-items:center;min-height:100vh;background:#fff}</style></head><body>${rawContent}</body></html>`;
  }
  if (language === "html" || language === "htm") {
    return injectPreviewCsp(rawContent, csp);
  }
  return `<!doctype html><html><head><meta charset="utf-8">${csp}<style>body{font:13px ui-monospace,SFMono-Regular,Menlo,monospace;margin:20px;white-space:pre-wrap;color:#202124}</style></head><body>${escapeHtml(rawContent)}</body></html>`;
}

function delimitedPreviewSrcdoc(rawContent, delimiter) {
  const rows = parseDelimitedText(rawContent, delimiter).slice(0, 500);
  const body = rows.map((row, rowIndex) => `<tr>${row.slice(0, 50).map((cell) =>
    `<${rowIndex === 0 ? "th" : "td"}>${escapeHtml(cell)}</${rowIndex === 0 ? "th" : "td"}>`
  ).join("")}</tr>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';"><style>body{margin:0;font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#202124}div{overflow:auto;padding:16px}table{border-collapse:collapse;white-space:pre-wrap}th,td{border:1px solid #d8dadd;padding:8px 10px;max-width:260px;vertical-align:top}th{position:sticky;top:0;background:#f1f3f4;text-align:left}</style></head><body><div><table>${body}</table></div></body></html>`;
}

function parseDelimitedText(value, delimiter) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  const text = String(value || "");
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') { field += '"'; index += 1; }
      else quoted = !quoted;
    } else if (character === delimiter && !quoted) {
      row.push(field); field = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += character;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}


function injectPreviewCsp(html, csp) {
  if (/<head[\s>]/i.test(html)) {
    return html.replace(/<head([^>]*)>/i, `<head$1>${csp}`);
  }
  return `<!doctype html><html><head><meta charset="utf-8">${csp}</head><body>${html}</body></html>`;
}


function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}


function escapeHtmlAttribute(value) {
  return escapeHtml(value).replace(/"/g, "&quot;");
}


function removeArtifactDirectory(directory) {
  try {
    fs.rmSync(directory, { recursive: true, force: true });
  } catch {
    // Best effort cleanup only.
  }
}


export {
  isSafeArtifactId,
  extractJobArtifacts,
  parseMarkdownCodeBlocks,
  parseFenceInfo,
  stripFenceQuotes,
  looksLikeFilename,
  cleanArtifactLanguage,
  cleanArtifactContent,
  referencedArtifactPaths,
  safeArtifactFilename,
  hasBlockedArtifactFilename,
  extensionForLanguage,
  languageForFilename,
  kindForArtifact,
  contentTypeForArtifact,
  writeJobArtifact,
  copyJobArtifact,
  titleForArtifact,
  isPreviewableArtifact,
  artifactRoute,
  assembleStaticPreviewArtifact,
  assembleStaticHtml,
  sanitizePersistedArtifacts,
  publicArtifactResponses,
  artifactPathBelongsToJob,
  serveJobArtifact,
  contentDispositionFilename,
  artifactPreviewWrapper,
  previewSrcdoc,
  delimitedPreviewSrcdoc,
  parseDelimitedText,
  injectPreviewCsp,
  escapeHtml,
  escapeHtmlAttribute,
  removeArtifactDirectory,
};
