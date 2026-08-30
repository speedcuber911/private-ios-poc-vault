// Starter content only; no execution, directory listing, or external listener.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function createSamplePreviewServer(workspaceRoot) {
  const sampleRoot = path.join(fs.realpathSync(workspaceRoot), "Launch checklist");
  return http.createServer((req, res) => {
    let pathname;
    try { pathname = new URL(req.url, "http://localhost").pathname; }
    catch { res.writeHead(400); res.end(); return; }
    if (!["GET", "HEAD"].includes(req.method) || !["/", "/lab"].includes(pathname)) {
      res.writeHead(404); res.end(); return;
    }
    try {
      const expectedRoot = path.resolve(sampleRoot);
      if (fs.realpathSync(sampleRoot) !== expectedRoot) throw new Error("sample_moved");
      const file = path.join(sampleRoot, "launch-checklist.html");
      if (fs.realpathSync(file) !== file) throw new Error("sample_moved");
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error("sample_unavailable");
      const body = fs.readFileSync(file);
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8", "Content-Length": body.length,
        "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'",
      });
      res.end(req.method === "HEAD" ? undefined : body);
    } catch { res.writeHead(404); res.end("Sample workspace is unavailable."); }
  });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const server = createSamplePreviewServer(process.env.CODEX_WORKSPACE_BROWSE_ROOT || "/srv/relay-workspaces");
  server.on("error", (error) => { console.error(`starter preview: ${error.code || "unavailable"}`); process.exitCode = 1; });
  server.listen(4317, "127.0.0.1");
}
