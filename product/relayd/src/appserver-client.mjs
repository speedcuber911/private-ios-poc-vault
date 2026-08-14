import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import readline from "node:readline";

class AppServerClient extends EventEmitter {
  constructor({ codexBin, cwd, env, experimental = false, requestTimeoutMs = 15000 }) {
    super();
    this.codexBin = codexBin;
    this.cwd = cwd;
    this.env = env;
    this.experimental = experimental;
    this.requestTimeoutMs = requestTimeoutMs;
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
  }

  async start() {
    if (this.child) return;
    const child = spawn(this.codexBin, ["app-server", "--stdio"], {
      cwd: this.cwd,
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stdin.on("error", (error) => {
      if (error?.code !== "EPIPE") this.emit("transportError", error);
    });
    readline.createInterface({ input: child.stdout }).on("line", (line) => this.#onLine(line));
    readline.createInterface({ input: child.stderr }).on("line", (line) => this.emit("stderr", line));
    child.once("error", (error) => this.#close(error));
    child.once("close", (code, signal) => {
      const detail = signal ? `signal ${signal}` : `code ${code}`;
      this.#close(new Error(`codex app-server closed with ${detail}`));
    });

    await this.request("initialize", {
      clientInfo: { name: "relay", title: "Relay", version: "0.1.0" },
      capabilities: this.experimental ? { experimentalApi: true } : {},
    });
    this.notify("initialized", {});
  }

  request(method, params = {}, { timeoutMs = this.requestTimeoutMs } = {}) {
    if (!this.child || this.closed) return Promise.reject(new Error("codex app-server is not connected"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0 ? setTimeout(() => {
        this.pending.delete(String(id));
        reject(new Error(`${method} timed out waiting for codex app-server`));
      }, timeoutMs) : null;
      timer?.unref?.();
      this.pending.set(String(id), { resolve, reject, method, timer });
      this.#write({ method, id, params });
    });
  }

  notify(method, params = {}) {
    this.#write({ method, params });
  }

  respond(id, result) {
    this.#write({ id, result });
  }

  respondError(id, code, message) {
    this.#write({ id, error: { code, message } });
  }

  stop() {
    if (!this.child || this.closed) return;
    this.child.kill("SIGTERM");
  }

  #write(message) {
    if (!this.child || this.closed) throw new Error("codex app-server is not connected");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #onLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.emit("protocolWarning", `invalid app-server JSON: ${line.slice(0, 500)}`);
      return;
    }
    if (message && message.id !== undefined && !message.method) {
      const pending = this.pending.get(String(message.id));
      if (!pending) return;
      this.pending.delete(String(message.id));
      if (pending.timer) clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message || `${pending.method} failed`));
      else pending.resolve(message.result);
      return;
    }
    if (message && message.method && message.id !== undefined) {
      this.emit("request", message);
      return;
    }
    if (message && message.method) this.emit("notification", message);
  }

  #close(error) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.emit("closed", error);
  }
}

export { AppServerClient };
