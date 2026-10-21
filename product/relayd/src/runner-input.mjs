// A job owns its follow-ups until its provider has accepted them. The phone
// can disconnect without losing the queue. Delivery and turn completion are
// serialized so promoting a queued message cannot send it twice.
export class RunnerInputQueue {
  constructor({ start, steer, finish, notify = () => {} }) {
    Object.assign(this, { start, steer, finish, notify });
    this.messages = new Map();
    this.chain = Promise.resolve();
    this.ready = false;
    this.closed = false;
  }

  serial(action) {
    this.chain = this.chain.then(action);
    return this.chain;
  }

  receive(input) {
    return this.serial(async () => {
      let message = this.messages.get(input.id);
      if (message && message.text !== input.text) return;
      if (message && message.status !== "queued") return;
      if (!message) {
        message = { ...input, status: "queued" };
        this.messages.set(message.id, message);
      } else if (input.mode === "now") message.mode = "now";
      if (this.closed) return this.update(message, "failed", "The run ended before this message was delivered.");
      this.update(message, "queued");
      if (this.ready && message.mode === "now") await this.deliver(message, this.steer);
    });
  }

  activate() {
    return this.serial(async () => {
      this.ready = true;
      for (const message of this.messages.values()) {
        if (message.status === "queued" && message.mode === "now") await this.deliver(message, this.steer);
      }
    });
  }

  turnFinished() {
    return this.serial(async () => {
      if (this.closed) return;
      for (const message of this.messages.values()) {
        if (message.status !== "queued") continue;
        if (await this.deliver(message, this.start)) return;
      }
      this.closed = true;
      this.notify({ type: "input.closed" });
      this.finish();
    });
  }

  async deliver(message, send) {
    this.update(message, "sending");
    try {
      await send(message);
      this.update(message, "sent");
      return true;
    } catch (error) {
      this.update(message, "failed", error?.message || "Could not deliver the message.");
      return false;
    }
  }

  update(message, status, error = undefined) {
    Object.assign(message, { status, error });
    this.notify({ type: "input.state", id: message.id, text: message.text, status, error });
  }
}

export function connectRunnerInput(options) {
  const queue = new RunnerInputQueue({ ...options, notify: (event) => {
    options.onState?.(event);
    if (process.connected) process.send(event, () => {});
  } });
  process.on("message", (event) => {
    if (event?.type === "input.submit") void queue.receive(event.message);
  });
  return queue;
}
