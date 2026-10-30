/** Thin Telegram Bot API client. No SDK: five methods is not worth a dependency. */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";

export interface BotConfig {
  token: string;
  /**
   * Who may reach it at all — Telegram user ids, bots included. Absent means everybody
   * (the old behaviour); an empty list means nobody but its own alarms.
   *
   * This is a pure whitelist: anyone else is dropped before the chat is even recorded,
   * so a stranger can neither wake it nor leave words in its inbox nor decide its home.
   */
  allow?: number[];
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

export interface TgFileRef {
  file_id: string;
  file_size?: number;
  file_name?: string;
  mime_type?: string;
}

export interface TgMessage {
  message_id: number;
  from?: { id: number; username?: string; first_name?: string };
  chat: { id: number; type: "private" | "group" | "supergroup" | "channel"; title?: string };
  text?: string;
  /** what an attachment with words looks like */
  caption?: string;
  /** the biggest size of a photo is the last entry */
  photo?: TgFileRef[];
  document?: TgFileRef;
  audio?: TgFileRef;
  video?: TgFileRef;
  animation?: TgFileRef;
  video_note?: TgFileRef;
  sticker?: TgFileRef;
  voice?: TgFileRef;
  entities?: TgEntity[];
  reply_to_message?: {
    message_id?: number;
    from?: { id: number; username?: string; first_name?: string };
    text?: string;
    caption?: string;
  };
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
  signal?: AbortSignal,
): Promise<TgUpdate[]> {
  try {
    return await call<TgUpdate[]>(
      token,
      "getUpdates",
      { offset, timeout: timeoutSec, allowed_updates: ["message"] },
      AbortSignal.any([
        AbortSignal.timeout((timeoutSec + 15) * 1000),
        ...(signal ? [signal] : []),
      ]),
    );
  } catch (err) {
    // long-poll timeouts and transient network errors are normal; retry next tick.
    // A deliberate abort is not: a reload is stopping this poller, and the loop above
    // has to be allowed to end.
    if (signal?.aborted) throw err;
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

/**
 * Returns the message id of every part actually sent, in order — the transcript wants
 * them so its own lines can be pointed at the same way someone else's can. A text split
 * into several Telegram messages yields several ids; the first is the anchor for the
 * whole text.
 */
export async function sendMessage(
  token: string,
  chat: number,
  text: string,
  threadId?: number,
  replyTo?: number,
): Promise<number[]> {
  const sent: number[] = [];
  for (const part of splitMessage(text)) {
    const message = await call<{ message_id: number }>(token, "sendMessage", {
      chat_id: chat,
      text: part,
      ...(threadId ? { message_thread_id: threadId } : {}),
      ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
    });
    sent.push(message.message_id);
  }
  return sent;
}

/**
 * "I am working on it" for up to five seconds; clients clear it the moment a message
 * arrives. Not a read receipt — the Bot API has no such thing for bots.
 */
/** Bots may download up to 20 MB; anything bigger is not ours to fetch. */
export const FILE_LIMIT = 20 * 1024 * 1024;

export async function getFilePath(token: string, fileId: string): Promise<string> {
  const file = await call<{ file_path?: string }>(token, "getFile", { file_id: fileId });
  if (!file.file_path) throw new Error("getFile 没给 file_path");
  return file.file_path;
}

export async function downloadFile(
  token: string,
  filePath: string,
  dest: string,
): Promise<number> {
  const response = await fetch(`${API}/file/bot${token}/${filePath}`, {
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`下载失败 HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > FILE_LIMIT) throw new Error(`文件超过 ${FILE_LIMIT} 字节`);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, bytes);
  return bytes.length;
}

const IMAGE_EXT = /\.(jpe?g|png|gif|webp)$/i;

/** Photos as photos, everything else as a document. `path` is a host path. */
export async function sendFile(token: string, chat: number, path: string): Promise<void> {
  const bytes = readFileSync(path);
  const name = basename(path);
  const form = new FormData();
  form.set("chat_id", String(chat));
  if (IMAGE_EXT.test(name)) {
    form.set("photo", new Blob([bytes]), name);
  } else {
    form.set("document", new Blob([bytes]), name);
  }
  const response = await fetch(`${API}/bot${token}/${IMAGE_EXT.test(name) ? "sendPhoto" : "sendDocument"}`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(120_000),
  });
  const text = await response.text();
  let body: { ok?: boolean; description?: string };
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`sendFile: HTTP ${response.status} ${text.slice(0, 200)}`);
  }
  if (!body.ok) throw new Error(`sendFile: ${body.description ?? `HTTP ${response.status}`}`);
}

export async function sendTyping(token: string, chat: number): Promise<void> {
  await call(token, "sendChatAction", { chat_id: chat, action: "typing" });
}

export function isMentioned(m: TgMessage, me: BotIdentity): boolean {
  const text = m.text ?? m.caption ?? "";
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

/** One spelling of a person's name, so a quote and a message never disagree. */
export function nameOf(from?: { username?: string; first_name?: string }): string | null {
  if (from?.username) return `telegram:@${from.username}`;
  if (from?.first_name) return `telegram:${from.first_name}`;
  return null;
}

export function senderName(m: TgMessage): string {
  return nameOf(m.from) ?? `telegram:${m.chat.id}`;
}
