import { existsSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { readJson, writeJson } from "./fs.ts";

export interface MuteEntry {
  until?: string | null;
  why?: string;
}

export type MuteMap = Record<string, MuteEntry>;

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

/**
 * `*` silences everything ambient; `dm` and `chat:<id>` are narrower — but `route()`
 * settles dm / mention / reply before it ever reads this, so only `*` and a group's
 * `chat:<id>` can bite (see `keyCanMute`).
 */
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

/**
 * The only mute keys that can change anything: ambient group talk. `route()` decides dm,
 * mention and reply *before* it looks at `muted`, so a `dm` entry is state that looks like
 * a silence and is not one. The page and the mute tool both read this so neither of them
 * announces a silence that does not exist.
 */
export function keyCanMute(key: string): boolean {
  return key === "*" || /^chat:-?\d+$/.test(key);
}

export interface OutboxItem {
  /** Which chat it meant to speak into; absent means home. */
  chat?: number;
  /** Container paths under /work that go out with the words. */
  files?: string[];
  /** Files the daemon resolved from an id of its own, already absolute on the host. */
  attachments?: { id: string; path: string; name: string }[];
  /** Answer one particular message, so the other side sees which line it is about. */
  replyTo?: { chat: number; messageId: number };
  file: string;
  id: string;
  messages: string[];
}

export function outboxDir(data: string): string {
  return join(data, "outbox");
}

/** An item written by an older or broken sender simply has no quote. */
function parseReplyTo(raw: unknown): { chat: number; messageId: number } | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as { chat?: unknown; messageId?: unknown };
  if (typeof o.chat !== "number" || typeof o.messageId !== "number") return undefined;
  if (!Number.isSafeInteger(o.chat) || !Number.isSafeInteger(o.messageId)) return undefined;
  return { chat: o.chat, messageId: o.messageId };
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
    const raw = readJson<{
      id?: string;
      messages?: unknown;
      text?: unknown;
      chat?: unknown;
      files?: unknown;
      attachments?: unknown;
      replyTo?: unknown;
    }>(join(dir, f), {});
    const messages = Array.isArray(raw.messages)
      ? raw.messages.filter((m): m is string => typeof m === "string" && m.trim() !== "")
      : typeof raw.text === "string" && raw.text.trim() !== ""
        ? [raw.text]
        : [];
    items.push({
      file: join(dir, f),
      id: raw.id ?? f.replace(/\.json$/, ""),
      files: Array.isArray(raw.files) ? raw.files.filter((x): x is string => typeof x === "string") : [],
      attachments: Array.isArray(raw.attachments)
        ? (raw.attachments as unknown[])
            .filter((x): x is { path: string; name: string } => {
              const o = x as { path?: unknown; name?: unknown } | null;
              return typeof o?.path === "string" && typeof o?.name === "string";
            })
            .map((x) => ({ ...x, id: "" }))
        : [],
      messages,
      chat: typeof raw.chat === "number" ? raw.chat : undefined,
      replyTo: parseReplyTo(raw.replyTo),
    });
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
