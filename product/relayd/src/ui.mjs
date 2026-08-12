// relayd ui.mjs — extracted verbatim from relay-server/codex-api-deploy/server.mjs (W2-CORE, behavior-preserving).
import http from "node:http";
import https from "node:https";
import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { proxyBaseUrl } from "./config.mjs";
import { workspaces, loadWorkspaces } from "./workspaces.mjs";
import { jobs } from "./jobs.mjs";

function codexThreadUiHtml() {
  return `<!doctype html>
<html lang="en" data-codex-thread-ui="true">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Codex Threads</title>
  <style>
    :root {
      color-scheme: light;
      --background: 0 0% 100%;
      --foreground: 222.2 84% 4.9%;
      --muted: 210 40% 96.1%;
      --muted-foreground: 215.4 16.3% 46.9%;
      --card: 0 0% 100%;
      --card-foreground: 222.2 84% 4.9%;
      --popover: 0 0% 100%;
      --popover-foreground: 222.2 84% 4.9%;
      --primary: 222.2 47.4% 11.2%;
      --primary-foreground: 210 40% 98%;
      --secondary: 210 40% 96.1%;
      --secondary-foreground: 222.2 47.4% 11.2%;
      --accent: 210 40% 96.1%;
      --accent-foreground: 222.2 47.4% 11.2%;
      --destructive: 0 84.2% 60.2%;
      --destructive-foreground: 210 40% 98%;
      --border: 214.3 31.8% 91.4%;
      --input: 214.3 31.8% 91.4%;
      --ring: 222.2 84% 4.9%;
      --radius: 10px;
      --ok: 142.1 76.2% 36.3%;
      --warning: 32 95% 44%;
      --surface: 220 14% 97%;
    }

    * { box-sizing: border-box; }
    html, body {
      height: 100%;
      min-height: 100%;
      overflow: hidden;
    }
    body {
      margin: 0;
      background: hsl(var(--surface));
      color: hsl(var(--foreground));
      font: 14px/1.5 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      letter-spacing: 0;
    }
    button, input, select {
      font: inherit;
    }
    button {
      border: 1px solid hsl(var(--border));
      background: hsl(var(--background));
      color: hsl(var(--foreground));
      border-radius: calc(var(--radius) - 3px);
      cursor: pointer;
      transition: background 140ms ease, border-color 140ms ease, color 140ms ease, transform 140ms ease;
    }
    button:hover { background: hsl(var(--accent)); }
    button:active { transform: translateY(1px); }
    button:focus-visible, input:focus-visible, select:focus-visible {
      outline: 2px solid hsl(var(--ring));
      outline-offset: 2px;
    }

    .shell {
      display: grid;
      grid-template-columns: minmax(320px, 380px) minmax(0, 1fr);
      height: 100vh;
      min-height: 0;
      overflow: hidden;
    }
    .sidebar {
      border-right: 1px solid hsl(var(--border));
      background: hsl(var(--background));
      display: flex;
      flex-direction: column;
      min-width: 0;
      min-height: 0;
    }
    .topbar {
      padding: 18px;
      border-bottom: 1px solid hsl(var(--border));
      flex: 0 0 auto;
    }
    .title-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 16px;
    }
    h1 {
      margin: 0;
      font-size: 20px;
      line-height: 1.15;
      font-weight: 700;
      letter-spacing: -0.01em;
    }
    .eyebrow {
      color: hsl(var(--muted-foreground));
      font-size: 12px;
      font-weight: 600;
      margin-bottom: 4px;
    }
    .source-pill {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      border: 1px solid hsl(var(--border));
      background: hsl(var(--secondary));
      color: hsl(var(--secondary-foreground));
      border-radius: 999px;
      padding: 5px 9px;
      font-size: 12px;
      white-space: nowrap;
    }
    .dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: hsl(var(--ok));
    }
    .dot.live {
      animation: pulse 1.5s ease-in-out infinite;
    }
    @keyframes pulse {
      0%, 100% { transform: scale(1); opacity: 1; }
      50% { transform: scale(1.45); opacity: 0.45; }
    }
    .refresh {
      min-height: 36px;
      padding: 0 13px;
      white-space: nowrap;
      font-weight: 600;
    }
    .filters {
      display: grid;
      grid-template-columns: 1fr;
      gap: 10px;
    }
    .filter-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 140px;
      gap: 8px;
    }
    input, select {
      width: 100%;
      border: 1px solid hsl(var(--input));
      background: hsl(var(--background));
      color: hsl(var(--foreground));
      border-radius: calc(var(--radius) - 3px);
      min-height: 38px;
      padding: 0 11px;
      box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
    }
    label.toggle {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      color: hsl(var(--muted-foreground));
      font-size: 12px;
      user-select: none;
    }
    label.toggle input {
      width: 15px;
      min-height: 15px;
      height: 15px;
      padding: 0;
      accent-color: hsl(var(--primary));
    }
    .meta-line {
      color: hsl(var(--muted-foreground));
      font-size: 12px;
      margin-top: 12px;
      min-height: 18px;
    }
    .thread-list {
      flex: 1 1 auto;
      min-height: 0;
      overflow: auto;
      padding: 10px;
    }
    .thread-row {
      width: 100%;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 12px;
      text-align: left;
      padding: 13px;
      margin: 0 0 8px;
      border-color: hsl(var(--border));
      background: hsl(var(--card));
      border-radius: var(--radius);
      box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
    }
    .thread-row:hover { background: hsl(var(--accent)); }
    .thread-row.active {
      border-color: hsl(var(--primary));
      box-shadow: 0 0 0 1px hsl(var(--primary)), 0 12px 28px rgba(15, 23, 42, 0.08);
    }
    .thread-main { min-width: 0; }
    .thread-title {
      font-weight: 650;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .thread-sub {
      margin-top: 4px;
      color: hsl(var(--muted-foreground));
      font-size: 12px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .thread-count {
      color: hsl(var(--muted-foreground));
      font-size: 12px;
      white-space: nowrap;
      display: grid;
      justify-items: end;
      gap: 6px;
    }
    .content {
      min-width: 0;
      min-height: 0;
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .detail-head {
      padding: 18px 26px 16px;
      border-bottom: 1px solid hsl(var(--border));
      background: rgba(255, 255, 255, 0.88);
      backdrop-filter: blur(14px);
      flex: 0 0 auto;
      z-index: 2;
    }
    .detail-head h2 {
      margin: 0 0 8px;
      font-size: 22px;
      line-height: 1.2;
      font-weight: 720;
      letter-spacing: -0.02em;
      overflow-wrap: anywhere;
      display: -webkit-box;
      -webkit-line-clamp: 3;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .detail-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 8px 14px;
      color: hsl(var(--muted-foreground));
      font-size: 12px;
    }
    .status {
      display: inline-flex;
      align-items: center;
      min-height: 22px;
      border-radius: 999px;
      padding: 2px 8px;
      border: 1px solid hsl(var(--border));
      background: hsl(var(--secondary));
      color: hsl(var(--secondary-foreground));
      font-size: 12px;
      font-weight: 650;
    }
    .status.succeeded { background: hsl(142 76% 96%); color: hsl(var(--ok)); border-color: hsl(142 55% 84%); }
    .status.failed, .status.timeout, .status.cancelled { background: hsl(0 86% 97%); color: hsl(var(--destructive)); border-color: hsl(0 80% 88%); }
    .status.running, .status.queued { background: hsl(42 100% 96%); color: hsl(var(--warning)); border-color: hsl(42 88% 82%); }
    .detail-body {
      flex: 1 1 auto;
      padding: 0;
      overflow: hidden;
      min-height: 0;
    }
    .grid {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(300px, 34%);
      gap: 0;
      align-items: stretch;
      height: 100%;
      min-height: 0;
    }
    .section {
      background: hsl(var(--card));
      border: 1px solid hsl(var(--border));
      border-radius: var(--radius);
      box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
      margin-bottom: 14px;
      overflow: hidden;
    }
    .section h3 {
      margin: 0;
      padding: 12px 14px;
      font-size: 12px;
      letter-spacing: 0;
      color: hsl(var(--muted-foreground));
      border-bottom: 1px solid hsl(var(--border));
      background: hsl(var(--muted) / 0.42);
    }
    .section-body { padding: 14px; }
    .empty {
      color: hsl(var(--muted-foreground));
      padding: 18px 14px;
    }
    .message {
      display: flex;
      gap: 10px;
      padding: 10px 0;
    }
    .message.user { justify-content: flex-end; }
    .message.assistant { justify-content: flex-start; }
    .role {
      color: hsl(var(--muted-foreground));
      font-size: 12px;
      font-weight: 700;
      margin-bottom: 5px;
    }
    .bubble {
      max-width: min(760px, 86%);
      border: 1px solid hsl(var(--border));
      border-radius: 16px;
      padding: 12px 13px;
      background: hsl(var(--background));
      box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
    }
    .message.user .bubble {
      background: hsl(var(--primary));
      color: hsl(var(--primary-foreground));
      border-color: hsl(var(--primary));
    }
    .message.user .role,
    .message.user .preview {
      color: hsl(var(--primary-foreground) / 0.76);
    }
    .message-text {
      overflow-wrap: anywhere;
      line-height: 1.55;
    }
    .markdown {
      overflow-wrap: anywhere;
      line-height: 1.58;
    }
    .markdown > *:first-child { margin-top: 0; }
    .markdown > *:last-child { margin-bottom: 0; }
    .markdown p {
      margin: 0 0 10px;
    }
    .markdown h1,
    .markdown h2,
    .markdown h3 {
      margin: 16px 0 8px;
      line-height: 1.22;
      letter-spacing: -0.01em;
    }
    .markdown h1 { font-size: 20px; }
    .markdown h2 { font-size: 17px; }
    .markdown h3 { font-size: 15px; }
    .markdown ul,
    .markdown ol {
      margin: 8px 0 12px;
      padding-left: 22px;
    }
    .markdown li {
      margin: 4px 0;
    }
    .markdown code {
      border: 1px solid hsl(var(--border));
      background: hsl(var(--muted));
      border-radius: 5px;
      padding: 1px 5px;
      font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    .message.user .markdown code {
      background: hsl(var(--primary-foreground) / 0.12);
      border-color: hsl(var(--primary-foreground) / 0.18);
      color: inherit;
    }
    .markdown pre {
      margin: 10px 0 12px;
      padding: 12px;
      background: hsl(222.2 47.4% 11.2%);
      color: hsl(var(--primary-foreground));
      border-radius: calc(var(--radius) - 2px);
      overflow: auto;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    .markdown pre code {
      border: 0;
      background: transparent;
      padding: 0;
      color: inherit;
      font: inherit;
    }
    .markdown blockquote {
      margin: 10px 0;
      padding: 8px 12px;
      border-left: 3px solid hsl(var(--border));
      color: hsl(var(--muted-foreground));
      background: hsl(var(--muted) / 0.55);
      border-radius: 0 calc(var(--radius) - 4px) calc(var(--radius) - 4px) 0;
    }
    .markdown a {
      color: hsl(221 83% 53%);
      text-decoration: underline;
      text-underline-offset: 3px;
    }
    .message.user .markdown a {
      color: inherit;
    }
    .job {
      border-bottom: 1px solid hsl(var(--border));
      padding: 12px 0;
    }
    .job:last-child { border-bottom: 0; }
    .log-tail {
      margin-top: 8px;
      max-height: 90px;
      overflow: auto;
      background: hsl(222.2 47.4% 11.2%);
      color: hsl(var(--primary-foreground));
      border-radius: calc(var(--radius) - 2px);
      padding: 10px;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      font: 11px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    .job-top {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
      margin-bottom: 8px;
    }
    .job-id {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 12px;
      overflow-wrap: anywhere;
      color: hsl(var(--muted-foreground));
    }
    .job-actions {
      display: flex;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
      flex: 0 0 auto;
    }
    .small-button {
      min-height: 30px;
      padding: 0 10px;
      font-size: 12px;
      font-weight: 600;
    }
    .job-summary {
      max-height: 92px;
      overflow: hidden;
      color: hsl(var(--muted-foreground));
      font-size: 12px;
      border-left: 2px solid hsl(var(--border));
      padding-left: 10px;
      margin-top: 8px;
    }
    .job-log-panel {
      margin-top: 12px;
      border: 1px solid hsl(var(--border));
      border-radius: calc(var(--radius) - 2px);
      background: hsl(var(--background));
      overflow: hidden;
    }
    .job-log-section {
      border-top: 1px solid hsl(var(--border));
    }
    .job-log-section:first-child {
      border-top: 0;
    }
    .job-log-title {
      padding: 9px 10px;
      color: hsl(var(--muted-foreground));
      background: hsl(var(--muted) / 0.48);
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.02em;
    }
    .job-log-body {
      max-height: 260px;
      overflow: auto;
      padding: 10px;
    }
    .preview {
      color: hsl(var(--muted-foreground));
      font-size: 12px;
      overflow-wrap: anywhere;
      margin-top: 6px;
    }
    pre {
      margin: 0;
      padding: 12px;
      background: hsl(222.2 47.4% 11.2%);
      color: hsl(var(--primary-foreground));
      border-radius: calc(var(--radius) - 2px);
      overflow: auto;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    .stats {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 10px;
      margin-bottom: 14px;
    }
    .stat {
      border: 1px solid hsl(var(--border));
      background: hsl(var(--card));
      border-radius: var(--radius);
      padding: 12px;
    }
    .stat-value {
      font-size: 20px;
      font-weight: 720;
      line-height: 1;
      letter-spacing: -0.02em;
    }
    .stat-label {
      color: hsl(var(--muted-foreground));
      font-size: 12px;
      margin-top: 6px;
    }
    .conversation {
      min-width: 0;
      min-height: 0;
      height: 100%;
      display: flex;
      flex-direction: column;
      border-right: 1px solid hsl(var(--border));
      background: hsl(var(--surface));
    }
    .conversation-scroll {
      flex: 1;
      min-height: 0;
      overflow: auto;
      padding: 22px 28px;
    }
    .inspector {
      height: 100%;
      min-height: 0;
      overflow: auto;
      padding: 18px;
      background: hsl(var(--background));
    }
    .chat-empty {
      border: 1px dashed hsl(var(--border));
      border-radius: var(--radius);
      padding: 24px;
      color: hsl(var(--muted-foreground));
      background: hsl(var(--background));
    }
    .composer {
      border: 0;
      border-top: 1px solid hsl(var(--border));
      background: hsl(var(--card));
      border-radius: 0;
      padding: 12px 18px;
      margin: 0;
      box-shadow: 0 -8px 28px rgba(15, 23, 42, 0.04);
    }
    .composer textarea {
      width: 100%;
      height: 72px;
      min-height: 72px;
      max-height: 150px;
      resize: vertical;
      border: 1px solid hsl(var(--input));
      background: hsl(var(--background));
      color: hsl(var(--foreground));
      border-radius: calc(var(--radius) - 3px);
      padding: 10px 11px;
      font: inherit;
      line-height: 1.5;
    }
    .composer-actions {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin-top: 10px;
    }
    .primary-button {
      min-height: 36px;
      padding: 0 14px;
      background: hsl(var(--primary));
      color: hsl(var(--primary-foreground));
      border-color: hsl(var(--primary));
      font-weight: 650;
    }
    .primary-button:hover {
      background: hsl(var(--primary) / 0.9);
    }
    .composer-status {
      color: hsl(var(--muted-foreground));
      font-size: 12px;
    }
    .split-stack {
      display: grid;
      gap: 10px;
      height: 100%;
      overflow: auto;
      padding: 18px;
    }
    .hidden { display: none !important; }

    @media (max-width: 900px) {
      .shell {
        grid-template-columns: 1fr;
      }
      .sidebar {
        height: 42vh;
        min-height: 0;
        border-right: 0;
        border-bottom: 1px solid hsl(var(--border));
      }
      .thread-list {
        max-height: 46vh;
      }
      .grid {
        grid-template-columns: 1fr;
        overflow: auto;
      }
      .detail-head {
        position: static;
      }
      .inspector {
        height: auto;
        overflow: visible;
        border-top: 1px solid hsl(var(--border));
      }
      .filter-row {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <main class="shell">
    <aside class="sidebar">
      <div class="topbar">
        <div class="title-row">
          <div>
            <div class="eyebrow">POC Vault</div>
            <h1>Codex Threads</h1>
          </div>
          <span class="source-pill"><span class="dot"></span>${proxyBaseUrl ? "Live via cert proxy" : "Local runner"}</span>
        </div>
        <div class="filters">
          <div class="filter-row">
            <input id="searchInput" type="search" placeholder="Search threads">
            <select id="workspaceSelect" aria-label="Workspace"></select>
          </div>
          <label class="toggle"><input id="hideSmokeInput" type="checkbox" checked> Hide smoke tests</label>
        </div>
        <div class="meta-line" id="listMeta"></div>
        <button class="refresh" id="refreshButton" type="button">Refresh threads</button>
      </div>
      <div class="thread-list" id="threadList"></div>
    </aside>
    <section class="content">
      <header class="detail-head">
        <h2 id="detailTitle">Select a thread</h2>
        <div class="detail-meta" id="detailMeta"></div>
      </header>
      <div class="detail-body" id="detailBody">
        <div class="empty">No thread selected.</div>
      </div>
    </section>
  </main>
  <script>
    (function () {
      var state = {
        workspaces: [],
        threads: [],
        selectedThreadId: null,
        selectedWorkspace: "",
        query: "",
        hideSmoke: true,
        selectedJobs: [],
        selectedThread: null,
        pollTimer: null,
        threadPollInFlight: false,
        listPollInFlight: false,
        lastPollAt: null,
        composerDrafts: Object.create(null)
      };

      var els = {
        refreshButton: document.getElementById("refreshButton"),
        searchInput: document.getElementById("searchInput"),
        workspaceSelect: document.getElementById("workspaceSelect"),
        hideSmokeInput: document.getElementById("hideSmokeInput"),
        listMeta: document.getElementById("listMeta"),
        threadList: document.getElementById("threadList"),
        detailTitle: document.getElementById("detailTitle"),
        detailMeta: document.getElementById("detailMeta"),
        detailBody: document.getElementById("detailBody")
      };

      function api(path) {
        return apiRequest(path);
      }

      function apiRequest(path, options) {
        options = options || {};
        var headers = options.headers || {};
        headers.accept = headers.accept || "application/json";
        return fetch(path, Object.assign({}, options, { headers: headers })).then(function (response) {
          if (!response.ok) {
            return response.json().catch(function () { return {}; }).then(function (body) {
              throw new Error(body.error || "Request failed with HTTP " + response.status);
            });
          }
          return response.json();
        });
      }

      function formatDate(value) {
        if (!value) return "unknown";
        var date = new Date(value);
        if (Number.isNaN(date.getTime())) return value;
        return date.toLocaleString();
      }

      function shortId(value) {
        return value ? value.slice(0, 8) : "unknown";
      }

      function statusClass(value) {
        return "status " + (value || "unknown");
      }

      function clear(node) {
        while (node.firstChild) node.removeChild(node.firstChild);
      }

      function captureComposerState() {
        var textarea = document.querySelector(".composer textarea");
        var chat = document.querySelector(".conversation-scroll");
        var inspector = document.querySelector(".inspector");
        var chatBottomGap = chat ? chat.scrollHeight - chat.scrollTop - chat.clientHeight : 0;
        var inspectorBottomGap = inspector ? inspector.scrollHeight - inspector.scrollTop - inspector.clientHeight : 0;
        var snapshot = {
          focused: false,
          threadId: null,
          selectionStart: 0,
          selectionEnd: 0,
          chatScrollTop: chat ? chat.scrollTop : 0,
          chatWasNearBottom: chat ? chatBottomGap < 32 : false,
          inspectorScrollTop: inspector ? inspector.scrollTop : 0,
          inspectorWasNearBottom: inspector ? inspectorBottomGap < 32 : false
        };
        if (!textarea) return snapshot;
        if (textarea.dataset.threadId) state.composerDrafts[textarea.dataset.threadId] = textarea.value;
        return {
          ...snapshot,
          focused: document.activeElement === textarea,
          threadId: textarea.dataset.threadId || null,
          selectionStart: textarea.selectionStart || 0,
          selectionEnd: textarea.selectionEnd || 0
        };
      }

      function restoreComposerState(thread, snapshot) {
        if (!snapshot) return;
        var chat = document.querySelector(".conversation-scroll");
        if (chat) {
          chat.scrollTop = snapshot.chatWasNearBottom ? chat.scrollHeight : snapshot.chatScrollTop || 0;
        }
        var inspector = document.querySelector(".inspector");
        if (inspector) {
          inspector.scrollTop = snapshot.inspectorWasNearBottom ? inspector.scrollHeight : snapshot.inspectorScrollTop || 0;
        }
        if (!snapshot.focused || snapshot.threadId !== thread.sessionId) return;
        var textarea = document.querySelector(".composer textarea[data-thread-id='" + thread.sessionId + "']");
        if (!textarea) return;
        textarea.focus();
        var start = Math.min(snapshot.selectionStart, textarea.value.length);
        var end = Math.min(snapshot.selectionEnd, textarea.value.length);
        textarea.setSelectionRange(start, end);
      }

      function el(tag, className, text) {
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined && text !== null) node.textContent = text;
        return node;
      }

      function appendInlineMarkdown(parent, text) {
        var tick = String.fromCharCode(96);
        var pattern = new RegExp(
          "(\\\\[[^\\\\]]+\\\\]\\\\(https?:\\\\/\\\\/[^\\\\s)]+\\\\)|" +
            tick + "[^" + tick + "]+" + tick +
            "|\\\\*\\\\*[^*]+\\\\*\\\\*|__[^_]+__|\\\\*[^*]+\\\\*|_[^_]+_)",
          "g"
        );
        var last = 0;
        var match;
        while ((match = pattern.exec(text)) !== null) {
          if (match.index > last) parent.appendChild(document.createTextNode(text.slice(last, match.index)));
          var token = match[0];
          if (token[0] === "[" && token.includes("](")) {
            var close = token.indexOf("](");
            var label = token.slice(1, close);
            var href = token.slice(close + 2, -1);
            var link = document.createElement("a");
            link.textContent = label;
            link.href = href;
            link.target = "_blank";
            link.rel = "noreferrer";
            parent.appendChild(link);
          } else if (token[0] === tick) {
            parent.appendChild(el("code", "", token.slice(1, -1)));
          } else if (token.startsWith("**") || token.startsWith("__")) {
            var strong = document.createElement("strong");
            strong.textContent = token.slice(2, -2);
            parent.appendChild(strong);
          } else {
            var em = document.createElement("em");
            em.textContent = token.slice(1, -1);
            parent.appendChild(em);
          }
          last = pattern.lastIndex;
        }
        if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
      }

      function appendParagraph(parent, lines) {
        if (!lines.length) return;
        var paragraph = document.createElement("p");
        appendInlineMarkdown(paragraph, lines.join(" "));
        parent.appendChild(paragraph);
        lines.length = 0;
      }

      function appendList(parent, tag, items) {
        if (!items.length) return;
        var list = document.createElement(tag);
        items.forEach(function (item) {
          var li = document.createElement("li");
          appendInlineMarkdown(li, item);
          list.appendChild(li);
        });
        parent.appendChild(list);
        items.length = 0;
      }

      function normalizeMarkdownText(value) {
        var tick = String.fromCharCode(96);
        var fence = tick + tick + tick;
        var text = String(value || "").replace(/\\r\\n/g, "\\n");
        var output = "";
        var cursor = 0;

        while (cursor < text.length) {
          var start = text.indexOf(fence, cursor);
          if (start === -1) {
            output += text.slice(cursor);
            break;
          }

          var close = text.indexOf(fence, start + fence.length);
          var chunk = text.slice(start + fence.length, close === -1 ? text.length : close);
          var lang = "";
          var content = chunk;
          var langMatch = content.match(/^([A-Za-z0-9_-]+)(?:\\s+|$)/);
          if (langMatch) {
            lang = langMatch[1];
            content = content.slice(langMatch[0].length);
          }

          output += text.slice(cursor, start);
          output += "\\n" + fence + lang + "\\n" + content.trim() + "\\n" + fence + "\\n";
          if (close === -1) break;
          cursor = close + fence.length;
        }

        return output;
      }

      function markdownNode(text) {
        var tick = String.fromCharCode(96);
        var root = el("div", "markdown");
        var lines = normalizeMarkdownText(text).split("\\n");
        var paragraph = [];
        var unordered = [];
        var ordered = [];
        var inCode = false;
        var codeLines = [];
        var codeLang = "";

        function flushBlocks() {
          appendParagraph(root, paragraph);
          appendList(root, "ul", unordered);
          appendList(root, "ol", ordered);
        }

        lines.forEach(function (line) {
          var fence = line.match(new RegExp("^" + tick + tick + tick + "\\\\s*([A-Za-z0-9_-]+)?\\\\s*$"));
          if (fence) {
            if (inCode) {
              var pre = document.createElement("pre");
              var code = document.createElement("code");
              if (codeLang) code.dataset.language = codeLang;
              code.textContent = codeLines.join("\\n");
              pre.appendChild(code);
              root.appendChild(pre);
              codeLines = [];
              codeLang = "";
              inCode = false;
            } else {
              flushBlocks();
              inCode = true;
              codeLang = fence[1] || "";
            }
            return;
          }

          if (inCode) {
            codeLines.push(line);
            return;
          }

          if (!line.trim()) {
            flushBlocks();
            return;
          }

          var heading = line.match(/^(#{1,3})\\s+(.+)$/);
          if (heading) {
            flushBlocks();
            var h = document.createElement("h" + heading[1].length);
            appendInlineMarkdown(h, heading[2].trim());
            root.appendChild(h);
            return;
          }

          var quote = line.match(/^>\\s?(.+)$/);
          if (quote) {
            flushBlocks();
            var blockquote = document.createElement("blockquote");
            appendInlineMarkdown(blockquote, quote[1].trim());
            root.appendChild(blockquote);
            return;
          }

          var bullet = line.match(/^\\s*[-*]\\s+(.+)$/);
          if (bullet) {
            appendParagraph(root, paragraph);
            appendList(root, "ol", ordered);
            unordered.push(bullet[1].trim());
            return;
          }

          var number = line.match(/^\\s*\\d+[.)]\\s+(.+)$/);
          if (number) {
            appendParagraph(root, paragraph);
            appendList(root, "ul", unordered);
            ordered.push(number[1].trim());
            return;
          }

          appendList(root, "ul", unordered);
          appendList(root, "ol", ordered);
          paragraph.push(line.trim());
        });

        if (inCode) {
          var pre = document.createElement("pre");
          var code = document.createElement("code");
          code.textContent = codeLines.join("\\n");
          pre.appendChild(code);
          root.appendChild(pre);
        }
        flushBlocks();
        return root;
      }

      function setError(error) {
        els.detailTitle.textContent = "Could not load";
        clear(els.detailMeta);
        clear(els.detailBody);
        els.detailBody.appendChild(el("div", "empty", error.message || String(error)));
      }

      function filteredThreads() {
        var query = state.query.trim().toLowerCase();
        return state.threads.filter(function (thread) {
          if (state.hideSmoke && thread.isSmokeTest) return false;
          if (!query) return true;
          return [
            thread.sessionId,
            thread.workspaceName,
            thread.lastPrompt,
            thread.lastResult,
            thread.lastError,
            thread.lastJobStatus
          ].join(" ").toLowerCase().includes(query);
        });
      }

      function renderWorkspaces() {
        clear(els.workspaceSelect);
        var all = document.createElement("option");
        all.value = "";
        all.textContent = "All workspaces";
        els.workspaceSelect.appendChild(all);
        state.workspaces.forEach(function (workspace) {
          var option = document.createElement("option");
          option.value = workspace.id;
          option.textContent = workspace.name;
          els.workspaceSelect.appendChild(option);
        });
        els.workspaceSelect.value = state.selectedWorkspace;
      }

      function renderThreads() {
        var previousScrollTop = els.threadList.scrollTop;
        var threads = filteredThreads();
        clear(els.threadList);
        els.listMeta.textContent = threads.length + " of " + state.threads.length + " threads";

        if (threads.length === 0) {
          els.threadList.appendChild(el("div", "empty", "No matching threads."));
          return;
        }

        threads.forEach(function (thread) {
          var row = document.createElement("button");
          row.type = "button";
          row.className = "thread-row" + (thread.id === state.selectedThreadId ? " active" : "");
          row.addEventListener("click", function () { selectThread(thread.id); });

          var main = el("div", "thread-main");
          main.appendChild(el("div", "thread-title", thread.lastPrompt || thread.lastResult || shortId(thread.sessionId)));
          main.appendChild(el("div", "thread-sub", thread.workspaceName + " - " + formatDate(thread.updatedAt)));

          var side = el("div", "thread-count");
          side.appendChild(el("div", "", String(thread.jobCount) + " jobs"));
          if (thread.lastJobStatus) {
            side.appendChild(el("span", statusClass(thread.lastJobStatus), thread.lastJobStatus));
          }

          row.appendChild(main);
          row.appendChild(side);
          els.threadList.appendChild(row);
        });
        els.threadList.scrollTop = previousScrollTop;
      }

      function section(title, bodyNode) {
        var wrapper = el("section", "section");
        wrapper.appendChild(el("h3", "", title));
        var body = el("div", "section-body");
        body.appendChild(bodyNode);
        wrapper.appendChild(body);
        return wrapper;
      }

      function renderTextSection(title, text) {
        return section(title, markdownNode(text || "None"));
      }

      function renderMessages(messages) {
        var body = el("div", "");
        if (!messages || messages.length === 0) {
          body.appendChild(el("div", "chat-empty", "No transcript messages found."));
          return body;
        }
        messages.forEach(function (message) {
          var row = el("div", "message " + message.role);
          var bubble = el("div", "bubble");
          bubble.appendChild(el("div", "role", message.role === "user" ? "You" : "Codex"));
          bubble.appendChild(markdownNode(message.text));
          if (message.timestamp) bubble.appendChild(el("div", "preview", formatDate(message.timestamp)));
          row.appendChild(bubble);
          body.appendChild(row);
        });
        return body;
      }

      function renderJobs(jobs) {
        if (!jobs || jobs.length === 0) return section("Jobs", el("div", "empty", "No jobs recorded for this thread."));
        var body = el("div", "");
        jobs.forEach(function (job) {
          var row = el("div", "job");
          var top = el("div", "job-top");
          top.appendChild(el("div", "job-id", job.id));
          var actions = el("div", "job-actions");
          actions.appendChild(el("span", statusClass(job.status), job.status));
          var open = el("button", "small-button", "Open logs");
          open.type = "button";
          actions.appendChild(open);
          top.appendChild(actions);
          row.appendChild(top);
          var preview = el("div", "job-summary");
          preview.appendChild(markdownNode(job.resultPreview || job.error || job.prompt || "No preview yet."));
          row.appendChild(preview);
          var tail = [job.stdoutPreview, job.stderrPreview].filter(Boolean).join("\\n").trim();
          if (tail && !job.resultPreview) {
            row.appendChild(el("div", "log-tail", tail));
          }
          var logMount = el("div", "hidden");
          row.appendChild(logMount);
          open.addEventListener("click", function () { toggleJobLogs(job, logMount, open); });
          body.appendChild(row);
        });
        return section("Jobs", body);
      }

      function appendLogSection(parent, title, text) {
        var value = String(text || "").trim();
        if (!value) return;
        var wrapper = el("div", "job-log-section");
        wrapper.appendChild(el("div", "job-log-title", title));
        var body = el("div", "job-log-body");
        body.appendChild(markdownNode(value));
        wrapper.appendChild(body);
        parent.appendChild(wrapper);
      }

      function toggleJobLogs(job, mount, button) {
        if (!mount.classList.contains("hidden")) {
          mount.classList.add("hidden");
          button.textContent = "Open logs";
          return;
        }

        mount.classList.remove("hidden");
        button.textContent = "Close logs";
        if (mount.dataset.loaded === "true") return;

        clear(mount);
        mount.appendChild(el("div", "empty", "Loading logs..."));
        api("/v1/codex/jobs/" + encodeURIComponent(job.id) + "?include=fullLogs").then(function (fullJob) {
          clear(mount);
          var panel = el("div", "job-log-panel");
          appendLogSection(panel, "Result", fullJob.result || fullJob.resultPreview);
          appendLogSection(panel, "Stdout", fullJob.stdout || fullJob.stdoutPreview);
          appendLogSection(panel, "Stderr", fullJob.stderr || fullJob.stderrPreview || fullJob.error);
          if (!panel.childNodes.length) {
            panel.appendChild(el("div", "empty", "No logs captured for this job."));
          }
          mount.appendChild(panel);
          mount.dataset.loaded = "true";
        }).catch(function (error) {
          clear(mount);
          mount.appendChild(el("div", "empty", error.message || String(error)));
        });
      }

      function threadPreviewMessages(thread) {
        var messages = [];
        if (thread.lastPrompt) {
          messages.push({ role: "user", text: thread.lastPrompt, timestamp: thread.updatedAt });
        }
        if (thread.lastResult || thread.lastError) {
          messages.push({
            role: "assistant",
            text: thread.lastResult || thread.lastError,
            timestamp: thread.updatedAt
          });
        }
        return messages;
      }

      function jobsToMessages(thread, jobs) {
        var messages = [];
        jobs
          .slice()
          .sort(function (left, right) {
            return Date.parse(left.createdAt || left.updatedAt || 0) - Date.parse(right.createdAt || right.updatedAt || 0);
          })
          .forEach(function (job) {
            if (job.prompt) {
              messages.push({ role: "user", text: job.prompt, timestamp: job.createdAt || job.startedAt || job.updatedAt });
            }
            var answer = job.resultPreview || job.result || job.error || job.stderrPreview || job.stdoutPreview;
            if (answer) {
              messages.push({ role: "assistant", text: answer, timestamp: job.finishedAt || job.updatedAt, status: job.status });
            } else if (job.status && job.status !== "succeeded") {
              messages.push({ role: "assistant", text: "Codex is " + job.status + "...", timestamp: job.updatedAt, status: job.status });
            }
          });
        return messages.length > 0 ? messages : threadPreviewMessages(thread);
      }

      function isActiveStatus(status) {
        return status === "queued" || status === "running";
      }

      function selectedHasActiveJob() {
        return state.selectedJobs.some(function (job) { return isActiveStatus(job.status); });
      }

      function renderConversation(thread, messages, jobs, detailNote, renderSnapshot) {
        state.selectedThread = thread;
        state.selectedJobs = jobs || [];
        var grid = el("div", "grid");
        var conversation = el("div", "conversation");
        var scroll = el("div", "conversation-scroll");
        if (messages && messages.length > 0) {
          scroll.appendChild(renderMessages(messages));
        } else {
          scroll.appendChild(el("div", "chat-empty", "No chat messages found for this thread yet."));
        }
        conversation.appendChild(scroll);
        conversation.appendChild(renderComposer(thread));

        var inspector = el("aside", "inspector");
        inspector.appendChild(renderStats(thread));
        inspector.appendChild(section("Live status", markdownNode(liveStatusText())));
        if (detailNote) {
          inspector.appendChild(section("Detail status", markdownNode(detailNote)));
        }
        inspector.appendChild(renderJobs(jobs || []));

        grid.appendChild(conversation);
        grid.appendChild(inspector);
        els.detailBody.appendChild(grid);
        restoreComposerState(thread, renderSnapshot);
      }

      function liveStatusText() {
        var cadence = selectedHasActiveJob() ? "Polling every 2s while active." : "Polling every 8s while idle.";
        var stamp = state.lastPollAt ? " Last check " + formatDate(state.lastPollAt) + "." : "";
        return cadence + stamp;
      }

      function renderStats(thread) {
        var stats = el("div", "stats");
        var jobStat = el("div", "stat");
        jobStat.appendChild(el("div", "stat-value", String(thread.jobCount || 0)));
        jobStat.appendChild(el("div", "stat-label", "Jobs"));
        var activeStat = el("div", "stat");
        activeStat.appendChild(el("div", "stat-value", String(thread.activeJobCount || 0)));
        activeStat.appendChild(el("div", "stat-label", "Active"));
        var sourceStat = el("div", "stat");
        sourceStat.appendChild(el("div", "stat-value", thread.hasSessionFile ? "Yes" : "No"));
        sourceStat.appendChild(el("div", "stat-label", "Session file"));
        stats.appendChild(jobStat);
        stats.appendChild(activeStat);
        stats.appendChild(sourceStat);
        return stats;
      }

      function renderComposer(thread) {
        var wrapper = el("div", "composer");
        var textarea = document.createElement("textarea");
        textarea.dataset.threadId = thread.sessionId;
        textarea.value = state.composerDrafts[thread.sessionId] || "";
        textarea.placeholder = "Reply on this Codex thread...";
        textarea.addEventListener("input", function () {
          state.composerDrafts[thread.sessionId] = textarea.value;
        });
        var actions = el("div", "composer-actions");
        var status = el("div", "composer-status", "Continues " + shortId(thread.sessionId));
        var button = el("button", "primary-button", "Send reply");
        button.type = "button";
        button.addEventListener("click", function () {
          var prompt = textarea.value.trim();
          if (!prompt) {
            status.textContent = "Write a reply first.";
            return;
          }
          button.disabled = true;
          status.textContent = "Sending...";
          apiRequest("/v1/codex/jobs", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              workspaceId: thread.workspaceId,
              provider: thread.provider || "codex",
              prompt: prompt,
              timeoutMs: 1800000,
              resumeSessionId: thread.sessionId
            })
          }).then(function (job) {
            textarea.value = "";
            state.composerDrafts[thread.sessionId] = "";
            status.textContent = "Queued job " + shortId(job.id || "");
            var current = state.threads.find(function (item) { return item.id === thread.id; }) || thread;
            current.lastPrompt = prompt;
            current.lastJobId = job.id || current.lastJobId;
            current.lastJobStatus = job.status || current.lastJobStatus || "queued";
            current.jobCount = (current.jobCount || 0) + 1;
            renderThreadSummaryOnly(current, "Reply queued. Refresh threads to watch status move.");
            loadThreadJobs(current);
            renderThreads();
          }).catch(function (error) {
            status.textContent = error.message || String(error);
          }).finally(function () {
            button.disabled = false;
          });
        });
        actions.appendChild(status);
        actions.appendChild(button);
        wrapper.appendChild(textarea);
        wrapper.appendChild(actions);
        return wrapper;
      }

      function renderDetail(body) {
        var renderSnapshot = captureComposerState();
        var thread = body.thread;
        els.detailTitle.textContent = thread.lastPrompt || thread.lastResult || thread.sessionId;
        clear(els.detailMeta);
        els.detailMeta.appendChild(el("span", "", thread.workspaceName));
        els.detailMeta.appendChild(el("span", "", "Updated " + formatDate(thread.updatedAt)));
        els.detailMeta.appendChild(el("span", "", thread.sessionId));
        if (thread.lastJobStatus) els.detailMeta.appendChild(el("span", statusClass(thread.lastJobStatus), thread.lastJobStatus));

        clear(els.detailBody);
        renderConversation(thread, body.messages, body.jobs, null, renderSnapshot);
      }

      function renderThreadSummaryOnly(thread, reason) {
        var renderSnapshot = captureComposerState();
        state.selectedThread = thread;
        state.selectedJobs = [];
        els.detailTitle.textContent = thread.lastPrompt || thread.lastResult || thread.sessionId;
        clear(els.detailMeta);
        els.detailMeta.appendChild(el("span", "", thread.workspaceName || "Workspace"));
        els.detailMeta.appendChild(el("span", "", "Updated " + formatDate(thread.updatedAt)));
        els.detailMeta.appendChild(el("span", "", thread.sessionId));
        if (thread.lastJobStatus) els.detailMeta.appendChild(el("span", statusClass(thread.lastJobStatus), thread.lastJobStatus));

        clear(els.detailBody);
        renderConversation(thread, threadPreviewMessages(thread), [], reason || "Full transcript detail is not available from this server yet.", renderSnapshot);
      }

      function renderJobDetail(job) {
        clear(els.detailBody);
        var stack = el("div", "split-stack");
        stack.appendChild(renderTextSection("Prompt", job.prompt || "None"));
        stack.appendChild(section("Result", el("pre", "", job.result || job.resultPreview || "")));
        stack.appendChild(section("Stdout", el("pre", "", job.stdout || job.stdoutPreview || "")));
        stack.appendChild(section("Stderr", el("pre", "", job.stderr || job.stderrPreview || "")));
        els.detailBody.appendChild(stack);
      }

      function loadThreadJobs(thread) {
        if (state.threadPollInFlight) return Promise.resolve();
        state.threadPollInFlight = true;
        return api("/v1/codex/jobs?limit=200").then(function (body) {
          var jobs = (body.jobs || []).filter(function (job) {
            return job.sessionId === thread.sessionId || job.resumeSessionId === thread.sessionId;
          });
          jobs.sort(function (left, right) {
            return Date.parse(left.createdAt || left.updatedAt || 0) - Date.parse(right.createdAt || right.updatedAt || 0);
          });
          if (state.selectedThreadId !== thread.id) return;
          state.lastPollAt = new Date().toISOString();
          thread.jobCount = jobs.length || thread.jobCount || 0;
          thread.activeJobCount = jobs.filter(function (job) { return isActiveStatus(job.status); }).length;
          if (jobs.length > 0) {
            var latest = jobs[jobs.length - 1];
            thread.lastJobId = latest.id || thread.lastJobId;
            thread.lastJobStatus = latest.status || thread.lastJobStatus;
            thread.lastPrompt = latest.prompt || thread.lastPrompt;
            thread.lastResult = latest.resultPreview || latest.result || latest.error || thread.lastResult;
            thread.updatedAt = latest.updatedAt || latest.finishedAt || thread.updatedAt;
          }
          var renderSnapshot = captureComposerState();
          clear(els.detailBody);
          renderConversation(thread, jobsToMessages(thread, jobs), jobs, jobs.length > 0 ? null : "No jobs were found for this thread yet.", renderSnapshot);
          renderThreads();
        }).catch(function () {
          if (state.selectedThreadId === thread.id) {
            renderThreadSummaryOnly(thread, "Could not load the job history, so this is the latest thread preview.");
          }
        }).finally(function () {
          state.threadPollInFlight = false;
        });
      }

      function selectThread(id) {
        state.selectedThreadId = id;
        renderThreads();
        var fallback = state.threads.find(function (thread) { return thread.id === id; });
        if (fallback) {
          renderThreadSummaryOnly(fallback, "Loading full transcript detail. The summary and latest job logs are usable now.");
          loadThreadJobs(fallback);
        } else {
          els.detailTitle.textContent = "Loading thread";
          clear(els.detailMeta);
          clear(els.detailBody);
          els.detailBody.appendChild(el("div", "empty", "Loading..."));
        }
        api("/v1/codex/threads/" + encodeURIComponent(id)).then(renderDetail).catch(function (error) {
          if (fallback) {
            renderThreadSummaryOnly(fallback, "Full transcript detail is not available here yet. The list summary and latest job logs are still usable.");
            return;
          }
          setError(error);
        });
      }

      function loadJob(id) {
        els.detailTitle.textContent = "Job " + shortId(id);
        clear(els.detailMeta);
        els.detailMeta.appendChild(el("span", "", id));
        clear(els.detailBody);
        els.detailBody.appendChild(el("div", "empty", "Loading logs..."));
        api("/v1/codex/jobs/" + encodeURIComponent(id) + "?include=fullLogs").then(renderJobDetail).catch(setError);
      }

      function loadThreads() {
        if (state.listPollInFlight) return Promise.resolve();
        state.listPollInFlight = true;
        els.listMeta.textContent = "Loading...";
        var params = new URLSearchParams();
        params.set("limit", "200");
        if (state.selectedWorkspace) params.set("workspaceId", state.selectedWorkspace);
        return api("/v1/codex/threads?" + params.toString()).then(function (body) {
          state.threads = body.threads || [];
          state.lastPollAt = new Date().toISOString();
          if (state.selectedThreadId && !state.threads.some(function (thread) { return thread.id === state.selectedThreadId; })) {
            state.selectedThreadId = null;
          }
          renderThreads();
          var threads = filteredThreads();
          if (!state.selectedThreadId && threads.length > 0) {
            selectThread(threads[0].id);
          } else if (state.selectedThreadId) {
            var current = state.threads.find(function (thread) { return thread.id === state.selectedThreadId; });
            if (current) state.selectedThread = current;
          }
        }).catch(function (error) {
          els.listMeta.textContent = error.message || String(error);
        }).finally(function () {
          state.listPollInFlight = false;
        });
      }

      function loadWorkspaces() {
        return api("/v1/codex/workspaces").then(function (body) {
          state.workspaces = body.workspaces || [];
          renderWorkspaces();
        });
      }

      function pollNow() {
        if (state.selectedThreadId && state.selectedThread) {
          loadThreadJobs(state.selectedThread);
        }
        loadThreads();
        schedulePoll();
      }

      function schedulePoll() {
        if (state.pollTimer) clearTimeout(state.pollTimer);
        var delay = selectedHasActiveJob() ? 2000 : 8000;
        state.pollTimer = setTimeout(pollNow, delay);
      }

      els.refreshButton.addEventListener("click", function () {
        if (state.selectedThread) loadThreadJobs(state.selectedThread);
        loadThreads();
      });
      els.searchInput.addEventListener("input", function () {
        state.query = els.searchInput.value;
        renderThreads();
      });
      els.workspaceSelect.addEventListener("change", function () {
        state.selectedWorkspace = els.workspaceSelect.value;
        state.selectedThreadId = null;
        loadThreads();
      });
      els.hideSmokeInput.addEventListener("change", function () {
        state.hideSmoke = els.hideSmokeInput.checked;
        renderThreads();
      });

      loadWorkspaces().then(loadThreads).then(schedulePoll).catch(setError);
    })();
  </script>
</body>
</html>`;
}


export {
  codexThreadUiHtml,
};
