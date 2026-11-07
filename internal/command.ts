import { dockerRun } from "./docker.ts";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Paths } from "./paths.ts";
import type { Policy } from "./policy.ts";
import { readSearchEnv, SEARCH_SOCKET_IN_CONTAINER } from "./search.ts";
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
  /** Replace the in-container command; used by the doctor probe. */
  tail?: string[],
): Command {
  // There is one way to run a round. The old `local` mode ran the host's pi with none of
  // the tools the page names, the operator's keys in reach and the book readable on disk —
  // a different agent wearing the same name, and it reported `sym=ok`.
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
    // The root filesystem is read-only, and that is about *immutability*, not persistence:
    // a writable layer would also be gone at exit, but until then it could rewrite `pi`, the
    // credential helper and `/etc/gitconfig`, which is the channel this round gets its
    // tokens through. So the writable places are named, few, and capped: /work (disk, in the
    // backup), and two tmpfs that only ever hold the round's own scratch.
    //
    // Everything a tmpfs can hold comes out of the same `container.memory`, and those pages
    // cannot be reclaimed, so the three caps together stay under a third of it — a runaway
    // cache should hit ENOSPC in a scratch dir, not OOM the round that is using the model.
    "--read-only",
    "--tmpfs",
    "/tmp:rw,nosuid,size=512m",
    // The home itself, not only the pi dir inside it: `HOME` is where tools drop their
    // caches, and `mkdir ~/.cache` used to fail on the read-only rootfs — `gh run view
    // --log` died on its cache and the error read like a network failure. `mode=1777` is
    // not decoration: a tmpfs mounted over a directory that exists in the image inherits
    // that directory's 0755, and the agent is not its owner, so without it the same mkdir
    // fails with EACCES instead of EROFS. This tmpfs masks the image's `/home/agent`
    // rather than being filled from it: `geng-pi` copies pi's packages in at the start of
    // the waking, and settings/models arrive as the mounts below.
    "--tmpfs",
    "/home/agent:rw,nosuid,size=128m,mode=1777",
    "--tmpfs",
    "/home/agent/.pi/agent:rw,size=32m",
    // the proxy lives on loopback, bridged to the book socket by `geng-pi`
    "-e",
    "HTTP_PROXY=http://127.0.0.1:3128",
    "-e",
    "HTTPS_PROXY=http://127.0.0.1:3128",
    "-e",
    "http_proxy=http://127.0.0.1:3128",
    "-e",
    "https_proxy=http://127.0.0.1:3128",
    "-e",
    "NO_PROXY=localhost,127.0.0.1,::1",
    "-e",
    "HOME=/home/agent",
    // every -e needs its own flag; a bare KEY=VALUE lands where the image name goes
    "-e",
    `TZ=${policy.timezone}`,
    "-v",
    `${paths.sessionDir}:/home/agent/.pi/agent/sessions`,
    "-v",
    `${join(paths.piDir, "settings.json")}:/home/agent/.pi/agent/settings.json:ro`,
    // pi posts model requests to the socat port below; the daemon adds the credential
    // on the way out, so no provider key is in this container's environment at all.
    "-v",
    `${join(paths.root, "deploy", "models.json")}:/home/agent/.pi/agent/models.json:ro`,
    // The book is not mounted at all. Every read and every write goes through the
    // endpoint, so a call is the only way in — a `cat` used to count as a read neither the
    // daemon nor the page could name. The single exception is the page it rewrites freely,
    // which is a file, not an action.
    "-v",
    `${paths.identity}:/state/identity.md`,
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
  // The book endpoint: a unix socket, no port. Read-only on the mount so the agent
  // cannot unlink the name and cut itself off mid-round.
  if (bookSocketExists(paths)) {
    args.push(
      "-v",
      `${paths.run}:/run/geng:ro`,
      "-e",
      `GENG_BOOK_SOCK=${BOOK_SOCKET_IN_CONTAINER}`,
    );
  }
  // The search endpoint is a socket too: nothing on the network can reach it, which is
  // why nothing else has to be opened for it. Mounted only when the file is there —
  // docker materialises a missing host path as a directory, and a directory at that path
  // fails at connect time with a shape nobody recognises.
  //
  // The host path is a runtime path with a uid in it (`/run/user/1002/geng/search.sock`);
  // handing the container that path is a naming leak even though the inode is the same.
  // The destination is `/run/search.sock` and not `/run/geng/search.sock` because docker
  // cannot make a mountpoint inside a read-only bind — see SEARCH_SOCKET_IN_CONTAINER.
  const search = readSearchEnv(paths.root);
  if (search !== null && existsSync(search.socket)) {
    args.push(
      "-v",
      `${search.socket}:${SEARCH_SOCKET_IN_CONTAINER}:ro`,
      "-e",
      `GENG_SEARCH_SOCKET=${SEARCH_SOCKET_IN_CONTAINER}`,
    );
  }
  // There is no direct network at all. Everything leaves through the proxy on the book
  // socket, so "it went somewhere" is a line in net.log rather than a route.
  args.push("--network", "none");
  // secrets are injected, never mounted
  if (existsSync(paths.secrets)) args.push("--env-file", paths.secrets);
  args.push(
    policy.container.image,
    // an empty replacement is not a command: only the probe passes one, and it passes
    // a real one
    ...(tail !== undefined && tail.length > 0
      ? tail
      : [
          "geng-pi",
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

/** A killed daemon leaves `docker run` children alive; nothing else cleans them up. */
export async function sweepOrphans(instance: string): Promise<number> {
  const listed = await dockerRun(["ps", "-q", "-f", `label=agent.instance=${instance}`], true);
  // A failed `docker ps` is not "no orphans": it is "could not tell". Reporting zero is
  // fine, but the output of a failed command must never be read as container ids.
  if (listed.code !== 0) return 0;
  const ids = listed.text.split("\n").map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) return 0;
  await dockerRun(["kill", ...ids], false);
  return ids.length;
}

export async function killContainer(instance: string): Promise<void> {
  await dockerRun(["kill", `agent-${instance}`], false);
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
