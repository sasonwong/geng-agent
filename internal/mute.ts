import { existsSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { readJson, writeJson } from "./state.ts";

export interface MuteEntry {
  until?: string | null;
  why?: string;
}

export type MuteMap = Record<string, MuteEntry>;

/**
 * Clearing a mute is a human's move: the agent must not be able to make itself
 * deaf and then quietly undo the evidence. `target` omitted clears everything.
 */
export function clearMutes(file: string, target?: string): string[] {
  const raw = readJson<MuteMap>(file, {});
  if (!target) {
    const keys = Object.keys(raw);
    if (keys.length > 0) writeJson(file, {});
    return keys;
  }
  if (!(target in raw)) return [];
  delete raw[target];
  writeJson(file, raw);
  return [target];
}

export function readMutes(file: string, nowMs: number): MuteMap {
  const raw = readJson<MuteMap>(file, {});
  const active: MuteMap = {};
  for (const [key, entry] of Object.entries(raw)) {
    if (!entry || typeof entry !== "object") continue;
    if (typeof entry.until === "string") {
      const at = Date.parse(entry.until);
      if (!Number.isNaN(at) && at <= nowMs) continue; // expired
    }
    active[key] = entry;
  }
  return active;
}

/** `*` silences everything ambient; `dm` and `chat:<id>` are narrower. */
export function isMuted(
  mutes: MuteMap,
  opts: { chatId: number; isDm: boolean },
): { muted: boolean; key: string | null } {
  const keys = ["*", ...(opts.isDm ? ["dm"] : []), `chat:${opts.chatId}`];
  for (const key of keys) {
    if (mutes[key]) return { muted: true, key };
  }
  return { muted: false, key: null };
}

export interface OutboxItem {
  file: string;
  id: string;
  messages: string[];
}

export function outboxDir(data: string): string {
  return join(data, "outbox");
}

export function readOutbox(dir: string): OutboxItem[] {
  const items: OutboxItem[] = [];
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return items;
  }
  for (const f of files) {
    const raw = readJson<{ id?: string; messages?: unknown; text?: unknown }>(join(dir, f), {});
    const messages = Array.isArray(raw.messages)
      ? raw.messages.filter((m): m is string => typeof m === "string" && m.trim() !== "")
      : typeof raw.text === "string" && raw.text.trim() !== ""
        ? [raw.text]
        : [];
    items.push({ file: join(dir, f), id: raw.id ?? f.replace(/\.json$/, ""), messages });
  }
  return items;
}

export function ackOutbox(dir: string, file: string): void {
  const sent = join(dir, "sent");
  mkdirSync(sent, { recursive: true });
  try {
    renameSync(file, join(sent, file.split("/").pop() as string));
  } catch {
    // if the rename fails the item is retried; the file may still be there
  }
}

export function ensureGatewayDirs(root: string): { ops: string; gateway: string } {
  const ops = join(root, "data", "_ops");
  const gateway = join(root, "data", "_gateway");
  for (const d of [join(ops, "outbox"), join(gateway, "outbox"), join(gateway, "usage")]) {
    mkdirSync(d, { recursive: true });
  }
  return { ops, gateway };
}

/** The daemon and gateway both speak on the ops channel; the tag says which mouth. */
export function writeOps(opsDir: string, tag: string, text: string): string {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const file = join(opsDir, "outbox", `${id}.json`);
  if (!existsSync(join(opsDir, "outbox"))) mkdirSync(join(opsDir, "outbox"), { recursive: true });
  writeJson(file, { id, messages: [`[${tag}] ${text}`] });
  return file;
}
