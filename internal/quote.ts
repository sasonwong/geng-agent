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

export function parseInboxId(s: string): Quote | null {
  if (typeof s !== "string") return null;
  const cut = s.lastIndexOf("-");
  if (cut <= 0) return null; // a chat id may start with -, so the split is the last one
  const chat = Number(s.slice(0, cut));
  const messageId = Number(s.slice(cut + 1));
  if (!Number.isSafeInteger(chat) || !Number.isSafeInteger(messageId)) return null;
  if (chat === 0 || messageId <= 0) return null;
  return { chat, messageId };
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
 * outbound message ids are deliberately not stored, so an id alone could not be resolved.
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
