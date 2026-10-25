/** Thin Telegram Bot API client. No SDK: five methods is not worth a dependency. */

export interface BotConfig {
  token: string;
  /** Which inbound messages are forwarded at all. Direct address always wins. */
  listen?: "all" | "mentions";
  /** Where to send unprompted messages; learned from the first inbound chat if absent. */
  chat?: number;
}

export interface TgEntity {
  type: string;
  offset: number;
  length: number;
}

export interface TgMessage {
  message_id: number;
  from?: { id: number; username?: string; first_name?: string };
  chat: { id: number; type: "private" | "group" | "supergroup" | "channel" };
  text?: string;
  entities?: TgEntity[];
  reply_to_message?: { from?: { id: number } };
  message_thread_id?: number;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
}

const API = "https://api.telegram.org";

export async function call<T>(
  token: string,
  method: string,
  params: Record<string, unknown> = {},
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`${API}/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
    signal: signal ?? AbortSignal.timeout(70_000),
  });
  const text = await response.text();
  let body: { ok?: boolean; result?: T; description?: string };
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${method}: HTTP ${response.status} ${text.slice(0, 200)}`);
  }
  if (!body.ok) throw new Error(`${method}: ${body.description ?? `HTTP ${response.status}`}`);
  return body.result as T;
}

export interface BotIdentity {
  id: number;
  username: string;
}

export function getMe(token: string): Promise<BotIdentity> {
  return call<BotIdentity>(token, "getMe");
}

export async function getUpdates(
  token: string,
  offset: number,
  timeoutSec = 50,
): Promise<TgUpdate[]> {
  try {
    return await call<TgUpdate[]>(
      token,
      "getUpdates",
      { offset, timeout: timeoutSec, allowed_updates: ["message"] },
      AbortSignal.timeout((timeoutSec + 15) * 1000),
    );
  } catch {
    // long-poll timeouts and transient network errors are normal; retry next tick
    return [];
  }
}

export function splitMessage(text: string, limit = 4000): string[] {
  if (text.length <= limit) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut < limit / 2) cut = limit;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length > 0) parts.push(rest);
  return parts;
}

export async function sendMessage(
  token: string,
  chat: number,
  text: string,
  threadId?: number,
): Promise<void> {
  for (const part of splitMessage(text)) {
    await call(token, "sendMessage", {
      chat_id: chat,
      text: part,
      ...(threadId ? { message_thread_id: threadId } : {}),
    });
  }
}

export function isMentioned(m: TgMessage, me: BotIdentity): boolean {
  const text = m.text ?? "";
  for (const e of m.entities ?? []) {
    if (e.type === "mention" || e.type === "text_mention") {
      const mentioned = text.slice(e.offset, e.offset + e.length);
      if (mentioned.toLowerCase() === `@${me.username.toLowerCase()}`) return true;
      if (e.type === "text_mention") return true;
    }
    if (e.type === "bot_command") return true;
  }
  return text.toLowerCase().includes(`@${me.username.toLowerCase()}`);
}

export function isReplyToBot(m: TgMessage, me: BotIdentity): boolean {
  return m.reply_to_message?.from?.id === me.id;
}

export function senderName(m: TgMessage): string {
  if (m.from?.username) return `telegram:@${m.from.username}`;
  if (m.from?.first_name) return `telegram:${m.from.first_name}`;
  return `telegram:${m.chat.id}`;
}
