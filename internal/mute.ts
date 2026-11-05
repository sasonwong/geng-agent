import { existsSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { basename, join } from "node:path";
import { readJson, writeJson } from "./fs.ts";
import { parseReplyTo } from "./quote.ts";

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
 * The ambient rule, and only that. `route()` settles dm / mention / reply before it asks,
 * so a `dm` entry in mute.json is state that looks like a silence and is not one: it was
 * read here, thrown away by the caller, and shown on the page as if it did something. Only
 * `*` and `chat:<id>` are considered — the same two keys `keyCanMute` lets anything write.
 */
export function isMuted(mutes: MuteMap, chatId: number): { muted: boolean; key: string | null } {
  for (const key of ["*", `chat:${chatId}`]) {
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
  attachments?: { path: string; name: string }[];
  /** Answer one particular message, so the other side sees which line it is about. */
  replyTo?: { chat: number; messageId: number };
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
    const raw = readJson<{
      id?: string;
      messages?: unknown;
      chat?: unknown;
      files?: unknown;
      attachments?: unknown;
      replyTo?: unknown;
    }>(join(dir, f), {});
    const messages = Array.isArray(raw.messages)
      ? raw.messages.filter((m): m is string => typeof m === "string" && m.trim() !== "")
      : [];
    items.push({
      file: join(dir, f),
      id: raw.id ?? f.replace(/\.json$/, ""),
      files: Array.isArray(raw.files) ? raw.files.filter((x): x is string => typeof x === "string") : [],
      attachments: Array.isArray(raw.attachments)
        ? (raw.attachments as unknown[]).filter((x): x is { path: string; name: string } => {
            const o = x as { path?: unknown; name?: unknown } | null;
            return typeof o?.path === "string" && typeof o?.name === "string";
          })
        : [],
      messages,
      chat: typeof raw.chat === "number" ? raw.chat : undefined,
      // an item written by an older or broken sender simply has no quote
      replyTo: parseReplyTo(raw.replyTo) ?? undefined,
    });
  }
  return items;
}

export function ackOutbox(dir: string, file: string): void {
  const sent = join(dir, "sent");
  mkdirSync(sent, { recursive: true });
  try {
    // basename, not a hand-rolled split: on a path with a different separator the split
    // returns the whole path and the file lands somewhere no one reads it from
    renameSync(file, join(sent, basename(file)));
  } catch {
    // if the rename fails the item is retried; the file may still be there
  }
}

/**
 * Take the parts that already went out of the queue file, so a retry says only the rest.
 * A multi-part send that failed half-way used to be retried whole: the first parts went
 * out twice, and the transcript (written as each part went out) showed the duplication.
 */
export function trimOutbox(file: string, sent: number): void {
  if (sent <= 0) return;
  const raw = readJson<Record<string, unknown> | null>(file, null);
  if (raw === null || !Array.isArray(raw.messages)) return;
  const left = (raw.messages as unknown[]).slice(sent);
  if (left.length === raw.messages.length) return;
  writeJson(file, { ...raw, messages: left });
}

export function ensureGatewayDirs(root: string): { ops: string } {
  // `_gateway` holds chats.json and offsets.json, written by the gateway itself; the ops
  // outbox is the only queue under `_ops`. Two more directories (a gateway outbox and a
  // gateway usage dir) were created here on every start and never written to.
  const ops = join(root, "data", "_ops");
  mkdirSync(join(ops, "outbox"), { recursive: true });
  return { ops };
}

/** The daemon and gateway both speak on the ops channel; the tag says which mouth. */
export function writeOps(opsDir: string, tag: string, text: string): string {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const file = join(opsDir, "outbox", `${id}.json`);
  if (!existsSync(join(opsDir, "outbox"))) mkdirSync(join(opsDir, "outbox"), { recursive: true });
  writeJson(file, { id, messages: [`[${tag}] ${text}`] });
  return file;
}
