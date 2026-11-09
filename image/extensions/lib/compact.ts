/**
 * The text that replaces a folded span when a round gets too long.
 *
 * No model is called: the raw session stays on the host and `recall(sources:["sessions"])`
 * can read it, so a prose summary would cost the tokens it was meant to save and lose the
 * exact tool output at the same time. What a fold must not lose is the first user message —
 * in geng that is the wake packet, and by the time a round is long enough to fold, the
 * packet has scrolled far out of the tail.
 */

/** How much of the original message survives: both ends, because the wake reason is last. */
const HEAD = 1_500;
const TAIL = 500;

interface Entry {
  type?: unknown;
  message?: { role?: unknown; content?: unknown };
}

interface Block {
  type?: unknown;
  text?: unknown;
}

function userText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const b of content) {
    if (b === null || typeof b !== "object") continue;
    const block = b as Block;
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n").trim();
}

/** The first user message is the one the round started with; later ones are steers. */
function firstUser(branch: readonly unknown[]): string | null {
  for (const item of branch) {
    if (item === null || typeof item !== "object") continue;
    const entry = item as Entry;
    if (entry.type !== "message" || entry.message?.role !== "user") continue;
    // an image-only first message has no text, and the next user message is not the goal
    return userText(entry.message.content) || null;
  }
  return null;
}

function clip(text: string): string {
  if (text.length <= HEAD + TAIL) return text;
  return `${text.slice(0, HEAD)}\n…（中间截断，原 ${text.length} 字）\n${text.slice(-TAIL)}`;
}

export function compactSummary(branch: readonly unknown[], folded: number): string {
  const goal = firstUser(branch);
  const count = folded > 0 ? `早先的 ${folded} 条消息已折叠` : "早先的消息已折叠";
  const notice = `[压缩] ${count}，这里不生成摘要；原文还在会话里：用 recall(sources:["sessions"]) 列出会话，最新的一条就是本轮，open(id) 读。`;
  return goal === null ? notice : `本轮开始时的原话：\n${clip(goal)}\n\n${notice}`;
}
