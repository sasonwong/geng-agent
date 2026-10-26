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

/** Four hours is the most it may ask for; longer than that is not attention, it is a rule. */
export const ATTENTION_MAX_MS = 4 * 3_600_000;

export function parseAttention(raw: unknown): Attention | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as { chats?: unknown; until?: unknown; why?: unknown };
  const chats = Array.isArray(o.chats)
    ? o.chats.filter((c): c is number | "*" => c === "*" || (typeof c === "number" && Number.isFinite(c)))
    : [];
  const untilMs = typeof o.until === "string" ? Date.parse(o.until) : NaN;
  if (chats.length === 0 || Number.isNaN(untilMs)) return null;
  return { chats, untilMs, why: typeof o.why === "string" ? o.why : undefined };
}

export function attentionActive(a: Attention | null, chatId: number, nowMs: number): boolean {
  if (!a || nowMs >= a.untilMs) return false;
  return a.chats.includes("*") || a.chats.includes(chatId);
}
