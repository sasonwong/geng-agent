import { spawn } from "node:child_process";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Paths } from "./paths.ts";
import type { Policy } from "./policy.ts";
import { readSearchEnv } from "./search.ts";
import { bookSocketExists, BOOK_SOCKET_IN_CONTAINER } from "./book.ts";

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

/**
 * Which files the container loads as extensions: whatever the mounted directory carries.
 * It was three hardcoded paths, so a fourth tool was mounted into the container and never
 * loaded — and nothing said so, while the page and the docs promise "add a tool, save it".
 * Sorted, so argv does not depend on readdir order.
 */
function extensionArgs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".ts"))
      .map((e) => e.name)
      .sort()
      .flatMap((f) => ["-e", `/opt/geng/extensions/${f}`]);
  } catch {
    // no checkout at all: `geng doctor --probe` has a count check for that
    return [];
  }
}

/**
 * A bind mount of a file that does not exist makes docker create a *directory* there, and
 * the agent would then be writing its identity onto a path a directory sits on. Empty is
 * what a book with no identity already reads as, so creating it changes nothing it can see.
 */
function ensureIdentityMountSource(paths: Paths): void {
  if (existsSync(paths.identity)) return;
  try {
    writeFileSync(paths.identity, "");
  } catch {
    // a book it cannot write is a fact for the round to report, not a reason to have none
  }
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
    ensureIdentityMountSource(paths);
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
      // The book is not mounted at all. Every read and every write goes through the
      // endpoint, so a call is the only way in and the ledger sees all of it — a `cat`
      // used to count as a read neither the daemon nor the page could name. The single
      // exception is the page it rewrites freely, which is a file, not an action.
      "-v",
      `${paths.identity}:/state/identity.md`,
      // the say extension writes /outbox; the gateway reads data/<inst>/outbox.
      // Top-level on purpose: a mount nested under /state makes docker create its
      // mountpoint through the bind, leaving root-owned junk in the agent's own book.
      "-v",
      `${paths.outbox}:/outbox`,
      // what people sent it: read-only, because a file it may not have looked at yet must
      // not be something it can edit
      "-v",
      `${paths.filesDir}:/files:ro`,
      // the tools come from the checkout, not from an image layer: read-only, at the same
      // absolute path the image used to copy them to, so `@earendil-works/pi-ai` keeps
      // resolving. Read-only is the point — it must not be able to rewrite how it speaks.
      "-v",
      `${paths.extensions}:/opt/geng/extensions:ro`,
      "-v",
      `${paths.workspace}:/work`,
      "-w",
      "/work",
    ];
    // The search endpoint is a unix socket, not a port on the bridge: nothing on the
    // network can reach it, which is why the egress rules no longer need an exception.
    // Mounted only when the file is there — docker materialises a missing host path as a
    // directory, and a directory at that path fails at connect time with a shape nobody
    // recognises.
    const search = readSearchEnv(paths.root);
    if (search !== null && existsSync(search.socket)) {
      args.push(
        "-v",
        `${search.socket}:${search.socket}:ro`,
        "-e",
        `GENG_SEARCH_SOCKET=${search.socket}`,
      );
    }
    // The book endpoint, same shape as search: a unix socket, no port. Read-only on the
    // mount so the agent cannot unlink the name and cut itself off mid-round.
    if (bookSocketExists(paths)) {
      args.push(
        "-v",
        `${paths.run}:/run/geng:ro`,
        "-e",
        `GENG_BOOK_SOCK=${BOOK_SOCKET_IN_CONTAINER}`,
      );
    }
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
        ...extensionArgs(paths.extensions),
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
      // the local runner reaches the same socket by its host path
      GENG_BOOK_SOCK: join(paths.run, "book.sock"),
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
