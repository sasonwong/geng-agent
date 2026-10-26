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

/**
 * A quote only means something inside the chat it came from: sent elsewhere it would
 * point at a message the reader cannot see, so it is dropped and the words go alone.
 */
export function quoteFor(chat: number, replyTo?: Quote): number | undefined {
  return replyTo && replyTo.chat === chat ? replyTo.messageId : undefined;
}
