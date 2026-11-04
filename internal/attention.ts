import { statSync } from "node:fs";
import { readJson } from "./state.ts";

/**
 * What it asked to hear. Ambient group traffic normally waits for a waking that is
 * happening anyway; a window here says "wake me for this chat until then".
 *
 * It expires on its own because being permanently interruptible is not something a
 * person chooses for hours at a time — and a window that never closed would turn a
 * conversation with another instance into a loop nobody stops.
 */
export interface Attention {
  chats: (number | "*")[];
  untilMs: number;
  why?: string;
}

/**
 * Four hours is the most it may ask for; longer than that is not attention, it is a rule.
 *
 * Enforced here, where the file is read, not only where `listen` writes it: the file lives
 * in the instance's own state directory, so a cap applied only there is a cap the instance
 * can step around with one `echo`.
 *
 * And the cap is measured from when the file was written, never from "now": `min(until,
 * now + MAX)` judged against that same `now` is true for every window ever written, so a
 * cap anchored at the reading instant enforces nothing while looking like it does.
 */
export const ATTENTION_MAX_MS = 4 * 3_600_000;

export function parseAttention(raw: unknown, nowMs: number, wroteMs: number): Attention | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as { chats?: unknown; until?: unknown; why?: unknown };
  const chats = Array.isArray(o.chats)
    ? o.chats.filter((c): c is number | "*" => c === "*" || (typeof c === "number" && Number.isFinite(c)))
    : [];
  const untilMs = typeof o.until === "string" ? Date.parse(o.until) : NaN;
  if (chats.length === 0 || Number.isNaN(untilMs)) return null;
  // Written later than "now" is not this machine's clock — the state dir is the instance's
  // own, and one `touch -d tomorrow` would otherwise buy a window the cap cannot see.
  if (wroteMs > nowMs) return null;
  // Only ever shortens: a window inside its cap keeps the time it was given.
  return { chats, untilMs: Math.min(untilMs, wroteMs + ATTENTION_MAX_MS), why: typeof o.why === "string" ? o.why : undefined };
}

/**
 * Read a window the way both readers need it: with the anchor the cap depends on, which is
 * the file's own mtime — the moment `listen` (or an `echo`) last wrote it.
 */
export function readAttention(file: string, nowMs: number): Attention | null {
  let wroteMs: number;
  try {
    wroteMs = statSync(file).mtimeMs;
  } catch {
    return null; // no file, no window
  }
  return parseAttention(readJson(file, null), nowMs, wroteMs);
}

export function attentionActive(a: Attention | null, chatId: number, nowMs: number): boolean {
  if (!a || nowMs >= a.untilMs) return false;
  return a.chats.includes("*") || a.chats.includes(chatId);
}
