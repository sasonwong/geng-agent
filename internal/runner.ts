import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Paths } from "./paths.ts";
import type { Policy } from "./policy.ts";

export interface RunOptions {
  paths: Paths;
  policy: Policy;
  prompt: string;
  sessionId: string;
}

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

const OUTPUT_CAP = 32 * 1024;
const KILL_GRACE_MS = 10_000;

function keepTail(buf: string, chunk: string): string {
  const next = buf + chunk;
  return next.length <= OUTPUT_CAP ? next : next.slice(next.length - OUTPUT_CAP);
}

function uidGid(): string {
  return `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`;
}

function dockerArgs(o: RunOptions): string[] {
  const { paths, policy, prompt, sessionId } = o;
  const name = `agent-${paths.instance}`;
  const args = [
    "run",
    "--rm",
    "--label",
    `agent.instance=${paths.instance}`,
    "--name",
    name,
    "--user",
    uidGid(),
    "--memory",
    policy.container.memory,
    "--cpus",
    policy.container.cpus,
    "--pids-limit",
    String(policy.container.pidsLimit),
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "-e",
    "HOME=/home/agent",
    "-v",
    `${paths.sessionDir}:/home/agent/.pi/agent/sessions`,
    "-v",
    `${paths.systemMd}:/home/agent/.pi/agent/SYSTEM.md:ro`,
    "-v",
    `${paths.palimpsest}:/state`,
    "-v",
    `${paths.palimpsest}/policy.json:/state/policy.json:ro`,
    "-v",
    `${paths.workspace}:/work`,
    "-w",
    "/work",
  ];
  // secrets are injected, never mounted
  if (existsSync(paths.secrets)) args.push("--env-file", paths.secrets);

  args.push(policy.container.image, "pi", "--print", "--session-id", sessionId, prompt);
  return args;
}

function localArgs(o: RunOptions): string[] {
  const { paths, prompt, sessionId } = o;
  return [
    "--print",
    "--session-id",
    sessionId,
    "--session-dir",
    paths.sessionDir,
    prompt,
  ];
}

function localEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("PI_")) continue; // never leak the host's pi configuration in
    env[k] = v;
  }
  return env;
}

export async function runCycle(o: RunOptions): Promise<RunResult> {
  const isDocker = o.policy.runner === "docker";
  const cmd = isDocker ? "docker" : "pi";
  const args = isDocker ? dockerArgs(o) : localArgs(o);
  const started = Date.now();

  return await new Promise<RunResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const child = spawn(cmd, args, {
      cwd: o.paths.workspace,
      env: isDocker ? process.env : localEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (c: string) => {
      stdout = keepTail(stdout, c);
    });
    child.stderr?.on("data", (c: string) => {
      stderr = keepTail(stderr, c);
    });

    const kill = () => {
      timedOut = true;
      if (isDocker) {
        spawn("docker", ["kill", `agent-${o.paths.instance}`], { stdio: "ignore" }).on(
          "error",
          () => {},
        );
        return;
      }
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS).unref();
    };

    const timer = setTimeout(kill, o.policy.cycle.timeoutSec * 1000);
    timer.unref();

    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code,
        signal,
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - started,
      });
    };

    child.on("error", (err) => {
      stderr = keepTail(stderr, String(err));
      finish(null, null);
    });
    child.on("close", finish);
  });
}

/** A killed daemon leaves `docker run` children alive; nothing else cleans them up. */
export async function sweepOrphans(instance: string): Promise<number> {
  const listed = await new Promise<string>((resolve) => {
    const p = spawn("docker", ["ps", "-q", "-f", `label=agent.instance=${instance}`], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    p.stdout?.setEncoding("utf8");
    p.stdout?.on("data", (c: string) => {
      out += c;
    });
    p.on("error", () => resolve(""));
    p.on("close", () => resolve(out));
  });
  const ids = listed.split("\n").map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) return 0;
  await new Promise<void>((resolve) => {
    const p = spawn("docker", ["kill", ...ids], { stdio: "ignore" });
    p.on("error", () => resolve());
    p.on("close", () => resolve());
  });
  return ids.length;
}

export function listSessionFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".jsonl")) out.push(full);
    }
  };
  walk(dir);
  return out.sort();
}
