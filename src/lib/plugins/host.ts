/**
 * Plugins are small JavaScript files from `.bmnotes/plugins/`. They run in a Web Worker with no network, no DOM and no
 * access to the app: the only way out is the `bmnotes` API below, which this host serves over `postMessage`.
 */

/** Source run inside the worker before the plugin's own code. */
export const BOOTSTRAP = `"use strict";
const __post = (m) => postMessage(m);
const __cmds = new Map();
let __rid = 0;
const __pending = new Map();
const __call = (op, args) => new Promise((resolve, reject) => { const id = ++__rid; __pending.set(id, { resolve, reject }); __post({ t: "call", id, op, args }); });
for (const k of ["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "importScripts", "indexedDB", "caches", "Worker", "SharedWorker", "BroadcastChannel"]) {
  try { Object.defineProperty(self, k, { value: undefined, configurable: false }); } catch (_) {}
}
self.bmnotes = Object.freeze({
  command(id, label, fn) {
    if (typeof id !== "string" || typeof label !== "string" || typeof fn !== "function") throw new Error("bmnotes.command(id, label, fn)");
    __cmds.set(id, fn);
    __post({ t: "command", id, label });
  },
  toast: (msg) => __post({ t: "toast", msg: String(msg) }),
  openNote: (path) => __post({ t: "open", path: String(path) }),
  prompt: (title) => __call("prompt", { title: String(title) }),
  notes: Object.freeze({
    list: () => __call("list", {}),
    read: (path) => __call("read", { path: String(path) }),
    write: (path, content) => __call("write", { path: String(path), content: String(content) }),
    create: (name, content) => __call("create", { name: String(name), content: String(content == null ? "" : content) }),
  }),
});
self.bm = self.bmnotes; // Compatibility for previously approved plugins.
onmessage = async (e) => {
  const m = e.data;
  if (m.t === "run") {
    try { const f = __cmds.get(m.id); if (f) await f(); __post({ t: "done", rid: m.rid }); }
    catch (err) { __post({ t: "done", rid: m.rid, error: String((err && err.message) || err) }); }
  } else if (m.t === "reply") {
    const p = __pending.get(m.id);
    if (p) { __pending.delete(m.id); if (m.error) p.reject(new Error(m.error)); else p.resolve(m.value); }
  }
};
`;

export interface WorkerLike {
  postMessage(message: unknown): void;
  terminate(): void;
  onmessage: ((e: { data: unknown }) => void) | null;
  onerror: ((e: unknown) => void) | null;
}

/** What a plugin may do. Everything else is unreachable from the worker. */
export interface HostApi {
  listNotes(): { path: string; title: string }[];
  readNote(path: string): string | null;
  writeNote(path: string, content: string): void;
  createNote(name: string, content: string): Promise<string | null>;
  openNote(path: string): void;
  prompt(title: string): Promise<string | null>;
  toast(message: string): void;
}

export interface PluginCommand {
  id: string;
  label: string;
}

const MAX_CALLS_PER_SECOND = 200;
export const COMMAND_TIMEOUT_MS = 10_000;

type Msg =
  | { t: "command"; id: string; label: string }
  | { t: "toast"; msg: string }
  | { t: "open"; path: string }
  | { t: "call"; id: number; op: string; args: Record<string, unknown> }
  | { t: "done"; rid: number; error?: string }
  | { t: "error"; error: string };

export class PluginHost {
  private worker: WorkerLike | null = null;
  private runs = new Map<number, { resolve: () => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private rid = 0;
  private calls = 0;
  private window = 0;
  readonly commands: PluginCommand[] = [];

  constructor(
    readonly name: string,
    private code: string,
    private api: HostApi,
    private make: (source: string) => WorkerLike,
    private onCommand: (c: PluginCommand) => void,
    private onFail: (message: string) => void,
  ) {}

  start(): void {
    this.worker = this.make(`${BOOTSTRAP}\ntry {\n(function () {\n${this.code}\n})();\n} catch (e) { __post({ t: "error", error: String((e && e.message) || e) }); }\n`);
    this.worker.onmessage = (e) => void this.handle(e.data as Msg);
    this.worker.onerror = () => this.onFail(`${this.name}: the plugin crashed`);
  }

  stop(): void {
    this.worker?.terminate();
    this.worker = null;
    for (const r of this.runs.values()) {
      clearTimeout(r.timer);
      r.reject(new Error("stopped"));
    }
    this.runs.clear();
  }

  /** Runs a registered command. Gives up (and stops the plugin) after 10 seconds. */
  run(id: string): Promise<void> {
    const w = this.worker;
    if (!w) return Promise.reject(new Error("The plugin is not running"));
    const rid = ++this.rid;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.runs.delete(rid);
        this.stop();
        this.onFail(`${this.name}: a command took longer than ${COMMAND_TIMEOUT_MS / 1000}s and the plugin was stopped`);
        reject(new Error("timeout"));
      }, COMMAND_TIMEOUT_MS);
      this.runs.set(rid, { resolve, reject, timer });
      w.postMessage({ t: "run", id, rid });
    });
  }

  private async handle(m: Msg): Promise<void> {
    switch (m.t) {
      case "command":
        if (typeof m.id === "string" && typeof m.label === "string" && m.id.length <= 60 && !this.commands.some((c) => c.id === m.id)) {
          const c = { id: m.id, label: m.label.slice(0, 80) };
          this.commands.push(c);
          this.onCommand(c);
        }
        return;
      case "toast":
        this.api.toast(String(m.msg).slice(0, 300));
        return;
      case "open":
        this.api.openNote(String(m.path));
        return;
      case "error":
        this.onFail(`${this.name}: ${m.error}`);
        return;
      case "done": {
        const r = this.runs.get(m.rid);
        if (!r) return;
        clearTimeout(r.timer);
        this.runs.delete(m.rid);
        if (m.error) {
          this.onFail(`${this.name}: ${m.error}`);
          r.reject(new Error(m.error));
        } else r.resolve();
        return;
      }
      case "call":
        await this.serve(m);
    }
  }

  private async serve(m: Extract<Msg, { t: "call" }>): Promise<void> {
    const reply = (value: unknown, error?: string) => this.worker?.postMessage({ t: "reply", id: m.id, value, error });
    const now = Date.now();
    if (now - this.window > 1000) {
      this.window = now;
      this.calls = 0;
    }
    if (++this.calls > MAX_CALLS_PER_SECOND) return reply(null, "Too many calls");
    try {
      const a = m.args ?? {};
      switch (m.op) {
        case "list": return reply(this.api.listNotes());
        case "read": {
          const text = this.api.readNote(String(a.path));
          return text === null ? reply(null, "No such note") : reply(text);
        }
        case "write":
          this.api.writeNote(String(a.path), String(a.content));
          return reply(true);
        case "create": return reply(await this.api.createNote(String(a.name), String(a.content ?? "")));
        case "prompt": return reply(await this.api.prompt(String(a.title)));
        default: return reply(null, "Unknown call");
      }
    } catch (e) {
      reply(null, e instanceof Error ? e.message : String(e));
    }
  }
}

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
