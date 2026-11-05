/**
 * Replying to one particular message, instead of dropping a line into the chat.
 *
 * The id it quotes is the same one the inbox already uses for the file name — `<chat>-<message_id>`
 * — so nothing new has to be invented for it to point at, and the chat is carried by the id
 * itself rather than guessed.
 */
export interface Quote {
  chat: number;
  messageId: number;
}

/** One set of rules for both spellings of a quote. */
function quoteOf(chat: number, messageId: number): Quote | null {
  if (!Number.isSafeInteger(chat) || !Number.isSafeInteger(messageId)) return null;
  if (chat === 0 || messageId <= 0) return null;
  return { chat, messageId };
}

export function parseInboxId(s: string): Quote | null {
  if (typeof s !== "string") return null;
  const cut = s.lastIndexOf("-");
  if (cut <= 0) return null; // a chat id may start with -, so the split is the last one
  const chat = Number(s.slice(0, cut));
  const messageId = Number(s.slice(cut + 1));
  return quoteOf(chat, messageId);
}

/**
 * A quote on the way in: the id a listing prints (`M-1001-151`, `-1001-151`, `#-1001-151`),
 * or the `{chat, messageId}` object an older tool description asked for. One reader, because
 * the tool writes a string and the outbox stores an object, and two parsers with different
 * rules is how a quote works on one path and 400s on the other.
 *
 * `undefined` is "no quote", `null` is "a quote that cannot be read" — the caller decides
 * whether that is a refusal or just an item from an older writer.
 */
export function parseReplyTo(raw: unknown): Quote | undefined | null {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "string") return parseInboxId(raw.trim().replace(/^[M#]/, ""));
  if (typeof raw !== "object") return null;
  const o = raw as { chat?: unknown; messageId?: unknown };
  if (typeof o.chat !== "number" || typeof o.messageId !== "number") return null;
  // The object spelling used to accept NaN, 1.5, 0 and negatives: those then reached
  // sendMessage as an invalid reply_to_message_id, and Telegram answered 400. The
  // string spelling already refused them — one reader, one set of rules.
  return quoteOf(o.chat, o.messageId);
}

/** The message someone answered, as far as it can be reconstructed from the update. */
export interface Quoted {
  id: string;
  from?: string;
  text?: string;
}

/**
 * Telegram ships the whole quoted message with the reply, and only its sender was ever
 * read (to tell "is this replying to me"). The rest is what tells a waking which line
 * the person is answering.
 *
 * The text is kept, not just the id, because the quoted message may be one of its own —
 * outbound ids are recorded from now on, but older lines were written without them, so an
 * id alone may point at a line this file cannot name.
 */
export function quotedOf(
  chatId: number,
  reply:
    | { message_id?: number; from?: { username?: string; first_name?: string }; text?: string; caption?: string }
    | undefined,
  nameOf: (from?: { username?: string; first_name?: string }) => string | null,
): Quoted | null {
  if (!reply || typeof reply.message_id !== "number") return null;
  const text = (reply.text ?? reply.caption ?? "").replace(/\s+/g, " ").trim();
  return {
    id: `${chatId}-${reply.message_id}`,
    ...(nameOf(reply.from) === null ? {} : { from: nameOf(reply.from) as string }),
    ...(text === "" ? {} : { text: text.length > 200 ? `${text.slice(0, 200)}…` : text }),
  };
}

/**
 * A quote only means something inside the chat it came from: sent elsewhere it would
 * point at a message the reader cannot see, so it is dropped and the words go alone.
 */
export function quoteFor(chat: number, replyTo?: Quote): number | undefined {
  return replyTo && replyTo.chat === chat ? replyTo.messageId : undefined;
}
