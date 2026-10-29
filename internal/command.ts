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
  /** The constant half of waking up, with the identity it wrote appended. */
  systemPrompt: string,
  /** Where it may speak, as chat ids: `say` refuses a chat that is not one of them, and
   *  with two or more it must be told which one. The count goes out next to them, for an
   *  extension older than this daemon — it reads the count and nothing else. */
  places: { id: number }[],
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
      // every -e needs its own flag; a bare KEY=VALUE lands where the image name goes
      "-e",
      `TZ=${policy.timezone}`,
      "-e",
      `GENG_PLACES=${places.length}`,
      "-e",
      `GENG_PLACE_IDS=${places.map((p) => p.id).join(",")}`,
      "-v",
      `${paths.sessionDir}:/home/agent/.pi/agent/sessions`,
      "-v",
      `${join(paths.piDir, "settings.json")}:/home/agent/.pi/agent/settings.json:ro`,
      "-v",
      `${paths.palimpsest}:/state`,
      // the say extension writes /outbox; the gateway reads data/<inst>/outbox.
      // Top-level on purpose: a mount nested under /state makes docker create its
      // mountpoint through the bind, leaving root-owned junk in the agent's own book.
      "-v",
      `${paths.outbox}:/outbox`,
      // read-only: the page points at these instead of pasting them, so they must be
      // readable from inside — but it must not be able to delete what a human said
      "-v",
      `${paths.inbox}:/inbox:ro`,
      "-v",
      `${paths.people}:/people:ro`,
      // what people sent it: read-only, because a file it may not have looked at yet must
      // not be something it can edit
      "-v",
      `${paths.filesDir}:/files:ro`,
      // every mail ever received, read-only and never moved: "read" is a list in its
      // own book, so the mailbox is nothing it can delete or rewrite
      "-v",
      `${paths.mail}:/mail:ro`,
      "-v",
      `${paths.workspace}:/work`,
      "-w",
      "/work",
    ];
    if (policy.container.network) args.push("--network", policy.container.network);
    // secrets are injected, never mounted
    if (existsSync(paths.secrets)) args.push("--env-file", paths.secrets);
    args.push(
      policy.container.image,
      ...(tail ?? [
        "pi",
        "--mode",
        "rpc",
        "--session-id",
        sessionId,
        "--system-prompt",
        systemPrompt,
        "-e",
        "/opt/geng/extensions/say-mute.ts",
        "-e",
        "/opt/geng/extensions/websearch.ts",
        "-e",
        "/opt/geng/extensions/mail.ts",
      ]),
    );
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
      "--system-prompt",
      systemPrompt,
    ],
    env: {
      ...localEnv(),
      GENG_PLACES: String(places.length),
      GENG_PLACE_IDS: places.map((p) => p.id).join(","),
    },
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
