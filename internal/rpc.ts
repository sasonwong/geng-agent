import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import type { Command } from "./command.ts";
import { killContainer } from "./command.ts";

export interface ToolCall {
  name: string;
  key: string;
  preview: string;
}

export interface Repeat {
  name: string;
  preview: string;
  count: number;
}

export interface SessionStats {
  cost: number | null;
  tokens: number | null;
  contextPercent: number | null;
}

export interface RpcResult {
  settled: boolean;
  aborted: boolean;
  timedOut: boolean;
  startFailed: boolean;
  code: number | null;
  signal: NodeJS.Signals | null;
  toolCalls: ToolCall[];
  repeat: Repeat | null;
  finalText: string;
  stats: SessionStats | null;
  interventions: string[];
  /** Messages pushed into this waking while it ran; `read` is whether a turn followed. */
  injections: { text: string; read: boolean }[];
  stderrTail: string;
  durationMs: number;
}

export interface RpcOptions {
  command: Command;
  instance: string;
  isDocker: boolean;
  timeoutMs: number;
  prompt: string;
  repeatThreshold: number;
  /** Messages that arrived mid-waking, polled while it runs. */
  drain?: () => string[];
}

const OUTPUT_CAP = 16 * 1024;

/**
 * RPC framing is strict LF JSONL, and `node:readline` is the wrong tool: it also
 * splits on U+2028/U+2029, which are legal inside JSON strings. So: manual splitter.
 */
export function makeSplitter(onRecord: (record: Record<string, unknown>) => void) {
  let buffer = "";
  return (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const at = buffer.indexOf("\n");
      if (at === -1) return;
      let line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.trim() === "") continue;
      try {
        onRecord(JSON.parse(line) as Record<string, unknown>);
      } catch {
        // a malformed record must not kill the waking; drop it
      }
    }
  };
}

function callKey(name: string, args: unknown): string {
  return createHash("sha1").update(`${name}\u0000${JSON.stringify(args)}`).digest("hex").slice(0, 12);
}

function callPreview(args: unknown): string {
  const text = JSON.stringify(args) ?? "null";
  return text.length <= 120 ? text : text.slice(0, 120) + "…";
}

/**
 * Counts identical calls and reports when one starts repeating. Pure function of
 * the call stream so it can be tested without a process.
 */
export class RepeatWatcher {
  private counts = new Map<string, number>();
  private threshold: number;
  repeat: Repeat | null = null;

  constructor(threshold: number) {
    this.threshold = threshold;
  }

  observe(call: ToolCall): Repeat | null {
    const n = (this.counts.get(call.key) ?? 0) + 1;
    this.counts.set(call.key, n);
    if (n >= this.threshold && (this.repeat === null || n > this.repeat.count)) {
      this.repeat = { name: call.name, preview: call.preview, count: n };
      return this.repeat;
    }
    return null;
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let activeKill: (() => void) | null = null;

/**
 * SIGTERM must abort the waking in flight instead of waiting for it: systemd gives
 * us a fixed TimeoutStopSec, after which it kills us mid-cleanup.
 */
export function abortActive(): void {
  activeKill?.();
}

export async function runWaking(o: RpcOptions): Promise<RpcResult> {
  const started = Date.now();
  const toolCalls: ToolCall[] = [];
  const watcher = new RepeatWatcher(o.repeatThreshold);
  const interventions: string[] = [];
  let stderrTail = "";
  let settled = false;
  let aborted = false;
  let timedOut = false;
  let startFailed = false;
  let steered = false;
  let compacted = false;
  let finalText = "";
  let stats: SessionStats | null = null;
  // `read` is not a guess: a steer is delivered before the next model call, so if no
  // assistant turn *starts* after we sent it, it never reached the model.
  const injections: { text: string; read: boolean }[] = [];
  let resolveSettled: () => void = () => {};
  const pending = new Map<string, (data: unknown) => void>();
  let nextId = 0;

  const child: ChildProcess = spawn(o.command.cmd, o.command.args, {
    cwd: o.command.cwd,
    env: o.command.env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const send = (record: Record<string, unknown>): Promise<unknown> | null => {
    const id = `geng-${++nextId}`;
    const payload = { id, ...record };
    child.stdin?.write(JSON.stringify(payload) + "\n");
    return new Promise((resolve) => {
      pending.set(id, resolve);
      setTimeout(() => {
        if (pending.delete(id)) resolve(undefined);
      }, 15_000).unref();
    });
  };

  const fire = (record: Record<string, unknown>) => {
    child.stdin?.write(JSON.stringify({ ...record, id: `geng-fire-${++nextId}` }) + "\n");
  };

  const split = makeSplitter((rec) => {
    const type = rec.type;
    if (type === "response") {
      const id = typeof rec.id === "string" ? rec.id : "";
      const resolve = pending.get(id);
      if (resolve) {
        pending.delete(id);
        resolve(rec.data);
      }
      return;
    }

    if (type === "tool_execution_start") {
      const name = String(rec.toolName ?? "?");
      const args = rec.args;
      const call: ToolCall = { name, key: callKey(name, args), preview: callPreview(args) };
      toolCalls.push(call);
      const repeat = watcher.observe(call);
      if (repeat && !steered) {
        steered = true;
        // level 1: hand it its own footprints, no advice
        fire({
          type: "steer",
          message: `[观察] 最近 ${repeat.count} 次动作是同一个：${repeat.name} ${repeat.preview}`,
        });
        interventions.push(`steer: ${repeat.name} x${repeat.count}`);
      } else if (repeat && !compacted) {
        compacted = true;
        // level 2: give it a way out of the dead end
        fire({ type: "compact" });
        interventions.push(`compact: ${repeat.name} x${repeat.count}`);
      }
      return;
    }

    if (type === "turn_start") {
      for (const i of injections) i.read = true;
      return;
    }

    if (type === "agent_settled") {
      settled = true;
      aborted = rec.aborted === true;
      resolveSettled();
      return;
    }
  });

  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (c: string) => split(c));
  child.stderr?.on("data", (c: string) => {
    const next = stderrTail + c;
    stderrTail = next.length <= OUTPUT_CAP ? next : next.slice(next.length - OUTPUT_CAP);
  });

  const settledPromise = new Promise<void>((resolve) => {
    resolveSettled = resolve;
  });

  let killed = false;
  const kill = async () => {
    if (killed) return;
    killed = true;
    if (o.isDocker) await killContainer(o.instance);
    else child.kill("SIGTERM");
  };

  activeKill = () => {
    fire({ type: "abort" });
    void kill();
  };

  const timer = setTimeout(async () => {
    timedOut = true;
    fire({ type: "abort" });
    await sleep(8_000);
    await kill();
    resolveSettled();
  }, o.timeoutMs);
  timer.unref();

  child.on("error", () => {
    startFailed = true;
    resolveSettled();
  });
  child.stdin?.on("error", () => {});

  const promptPromise = send({ type: "prompt", message: o.prompt });
  const accepted = (await promptPromise) as { disposition?: string } | undefined;
  if (!accepted || accepted.disposition === "handled") {
    // nothing will settle if the prompt never started a run
    if (!accepted) startFailed = true;
    resolveSettled();
  }

  // A live message lands after the current turn's tool calls, before the next model
  // call: exactly the gap between actions. It cannot cut into a running bash command.
  const drainTimer = setInterval(() => {
    if (settled || timedOut || startFailed || !o.drain) return;
    for (const message of o.drain()) {
      injections.push({ text: message, read: false });
      fire({ type: "steer", message });
    }
  }, 2_000);
  drainTimer.unref();

  await settledPromise;
  clearInterval(drainTimer);

  if (!timedOut && !startFailed) {
    const text = (await send({ type: "get_last_assistant_text" })) as
      | { text?: string }
      | undefined;
    if (text && typeof text.text === "string") finalText = text.text;
    const s = (await send({ type: "get_session_stats" })) as
      | { cost?: number; tokens?: { total?: number }; contextUsage?: { percent?: number | null } }
      | undefined;
    if (s) {
      stats = {
        cost: typeof s.cost === "number" ? s.cost : null,
        tokens: typeof s.tokens?.total === "number" ? s.tokens.total : null,
        contextPercent:
          typeof s.contextUsage?.percent === "number" ? s.contextUsage.percent : null,
      };
    }
  }

  clearTimeout(timer);
  try {
    child.stdin?.end();
  } catch {
    // already gone
  }
  if (!timedOut) {
    // give pi a moment to exit on its own, then insist
    await Promise.race([new Promise<void>((r) => child.on("close", () => r())), sleep(3_000)]);
    await kill();
  }

  activeKill = null;

  return {
    settled,
    aborted,
    timedOut,
    startFailed,
    code: child.exitCode,
    signal: child.signalCode,
    toolCalls,
    repeat: watcher.repeat,
    finalText,
    stats,
    interventions,
    injections,
    stderrTail,
    durationMs: Date.now() - started,
  };
}
