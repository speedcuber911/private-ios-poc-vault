// relayd transcribe.mjs — extracted verbatim from relay-server/codex-api-deploy/server.mjs (W2-CORE, behavior-preserving).
import http from "node:http";
import https from "node:https";
import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { azureSpeechEndpoint, azureSpeechApiKey, azureSpeechApiVersion, azureSpeechModel, azureSpeechLocales } from "./config.mjs";
import { headerValue, cleanApiText } from "./util.mjs";
import { appendAudit } from "./audit.mjs";

async function transcribeAudio({ audio, contentType, filename, certSubject }) {
  if (!azureSpeechEndpoint || !azureSpeechApiKey) {
    throw Object.assign(new Error("Azure Speech is not configured for transcription"), { status: 503 });
  }

  const definition = {
    locales: azureSpeechLocales.length > 0 ? azureSpeechLocales : ["en"],
    enhancedMode: {
      enabled: true,
      model: azureSpeechModel,
    },
  };
  const form = multipartFormData([
    {
      name: "audio",
      filename,
      contentType,
      value: audio,
    },
    {
      name: "definition",
      value: Buffer.from(JSON.stringify(definition), "utf8"),
    },
  ]);
  const endpoint = `${azureSpeechEndpoint}/speechtotext/transcriptions:transcribe?api-version=${encodeURIComponent(azureSpeechApiVersion)}`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": form.contentType,
      "content-length": String(form.body.length),
      "ocp-apim-subscription-key": azureSpeechApiKey,
    },
    body: form.body,
  });
  const responseText = await response.text();
  let payload = null;
  if (responseText.trim()) {
    try {
      payload = JSON.parse(responseText);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    throw Object.assign(new Error(`Azure Speech failed with HTTP ${response.status}: ${azureSpeechErrorMessage(payload, responseText)}`), {
      status: 502,
    });
  }

  const text = azureTranscriptText(payload);
  appendAudit(
    "transcription_created",
    { id: null, status: "succeeded", workspaceId: null, certSubject },
    { provider: "azure-speech", model: azureSpeechModel, audioBytes: audio.length },
  );
  return {
    text,
    provider: "azure-speech",
    model: azureSpeechModel,
    audioBytes: audio.length,
    durationMilliseconds: Number.isFinite(payload?.durationMilliseconds) ? payload.durationMilliseconds : null,
  };
}


function multipartFormData(parts) {
  const boundary = `----codex-${crypto.randomUUID()}`;
  const chunks = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`, "utf8"));
    const disposition = [`form-data`, `name="${escapeMultipartValue(part.name)}"`];
    if (part.filename) disposition.push(`filename="${escapeMultipartValue(part.filename)}"`);
    chunks.push(Buffer.from(`content-disposition: ${disposition.join("; ")}\r\n`, "utf8"));
    if (part.contentType) {
      chunks.push(Buffer.from(`content-type: ${part.contentType}\r\n`, "utf8"));
    }
    chunks.push(Buffer.from("\r\n", "utf8"));
    chunks.push(Buffer.isBuffer(part.value) ? part.value : Buffer.from(String(part.value), "utf8"));
    chunks.push(Buffer.from("\r\n", "utf8"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));
  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}


function escapeMultipartValue(value) {
  return String(value).replace(/["\r\n]/g, "_");
}


function cleanAudioContentType(value) {
  const raw = headerValue(value).split(";")[0].trim().toLowerCase();
  const allowed = new Set([
    "audio/wav",
    "audio/x-wav",
    "audio/wave",
    "audio/mpeg",
    "audio/mp4",
    "audio/m4a",
    "audio/flac",
    "audio/webm",
    "audio/aac",
    "audio/ogg",
    "application/octet-stream",
  ]);
  return allowed.has(raw) ? raw : "audio/wav";
}


function cleanAudioFilename(value) {
  const raw = path.basename(headerValue(value).trim());
  const cleaned = raw.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 120);
  return cleaned && /\.[A-Za-z0-9]{2,8}$/.test(cleaned) ? cleaned : "phone-prompt.wav";
}


function azureTranscriptText(payload) {
  const combinedText = Array.isArray(payload?.combinedPhrases)
    ? payload.combinedPhrases
        .map((phrase) => cleanApiText(phrase?.text || "").trim())
        .filter(Boolean)
        .join("\n")
        .trim()
    : "";
  if (combinedText) return combinedText;

  const phraseText = Array.isArray(payload?.phrases)
    ? payload.phrases
        .map((phrase) => cleanApiText(phrase?.text || "").trim())
        .filter(Boolean)
        .join(" ")
        .trim()
    : "";
  if (phraseText) return phraseText;

  throw Object.assign(new Error("Azure Speech returned no transcript"), { status: 502 });
}


function azureSpeechErrorMessage(payload, fallback) {
  const message =
    payload?.error?.message ||
    payload?.message ||
    payload?.innerError?.message ||
    cleanApiText(fallback || "").trim();
  return message || "transcription request failed";
}


export {
  transcribeAudio,
  multipartFormData,
  escapeMultipartValue,
  cleanAudioContentType,
  cleanAudioFilename,
  azureTranscriptText,
  azureSpeechErrorMessage,
};
