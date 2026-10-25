import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Paths } from "./paths.ts";
import type { Policy } from "./policy.ts";

export interface Command {
  cmd: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
}

function uidGid(): string {
  return `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`;
}

function localEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("PI_")) continue; // never leak the host's pi configuration in
    env[k] = v;
  }
  return env;
}

export function buildCommand(
  paths: Paths,
  policy: Policy,
  sessionId: string,
  /** Replace the in-container command; used by the doctor probe. */
  tail?: string[],
): Command {
  if (policy.runner === "docker") {
    const args = [
      "run",
      "--rm",
      "-i",
      "--label",
      `agent.instance=${paths.instance}`,
      "--name",
      `agent-${paths.instance}`,
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
      `${join(paths.piDir, "settings.json")}:/home/agent/.pi/agent/settings.json:ro`,
      "-v",
      `${paths.palimpsest}:/state`,
      "-v",
      `${paths.palimpsest}/policy.json:/state/policy.json:ro`,
      "-v",
      `${paths.workspace}:/work`,
      "-w",
      "/work",
    ];
    if (policy.container.network) args.push("--network", policy.container.network);
    // secrets are injected, never mounted
    if (existsSync(paths.secrets)) args.push("--env-file", paths.secrets);
    args.push(policy.container.image, ...(tail ?? ["pi", "--mode", "rpc", "--session-id", sessionId]));
    return { cmd: "docker", args, env: process.env, cwd: paths.workspace };
  }

  return {
    cmd: "pi",
    args: [
      "--mode",
      "rpc",
      "--session-id",
      sessionId,
      "--session-dir",
      paths.sessionDir,
    ],
    env: localEnv(),
    cwd: paths.workspace,
  };
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

export async function killContainer(instance: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const p = spawn("docker", ["kill", `agent-${instance}`], { stdio: "ignore" });
    p.on("error", () => resolve());
    p.on("close", () => resolve());
  });
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
