import type { Attachment } from "../attach.ts";
import type { OutboxItem } from "../mute.ts";
import type { Quote, Quoted } from "../quote.ts";

/**
 * The contract between the gateway's core and a transport.
 *
 * Core owns what a message *means*: the inbox, the transcript, routing, mute,
 * attention, the brake. A channel owns the wire: credentials, long polls, cursors,
 * attachments on the way in and out, and a session's way of saying "I am gone".
 * Adding one is a module plus a line in `index.ts`; there is no runtime plugin
 * loading, because a channel is code and code comes from the checkout.
 */
export interface Channel {
  id: string;
  /** Per-instance credentials, as the channel's own file spells them. */
  load(root: string): LoadResult;
  /** A reload must survive a half-written file: a missing token keeps the old one. */
  merge(running: Record<string, unknown>, next: Record<string, unknown>): MergeResult;
  /** Only a changed fingerprint moves a poller; `allow`/`listen` are read per message. */
  fingerprint(cfg: unknown): string;
  /** Where a send with no explicit chat goes: the pinned target, else home. */
  defaultChat?(cfg: unknown, chats: Chats | undefined): number | undefined;
  /** One line for a reload's log, without secrets. */
  describe?(instance: string, cfg: unknown, chats: Chats | undefined): string;
  /** Run until `signal` aborts. Every normalized message goes through `onInbound`. */
  start(ctx: StartContext): Promise<void>;
  /**
   * Can this channel send right now? The core asks before the tripwire records an
   * attempt: a held item is retried every two seconds, and counting those attempts as
   * sends would trip the brake on a message that never left.
   *
   * A non-null answer is returned to the sweep as-is; `null` means "go ahead and send".
   */
  ready?(ctx: SendContext): SendResult | null;
  send(ctx: SendContext): Promise<SendResult>;
  typing?(ctx: TypingContext): Promise<void>;
  /** `gateway --check`: prove the credential without starting a poll. */
  check?(cfg: unknown): Promise<string>;
  /** The same three states doctor uses: absent is a warn, present-and-wrong is a FAIL. */
  doctor?(root: string, instance: string): ChannelCheck[];
  /** A manual login for channels that do not use a pasted token (a QR scan). */
  login?(ctx: LoginContext): Promise<void>;
}

export interface LoginContext {
  root: string;
  instance: string;
  /** A human-readable name the operator chose, when the login flow can use one. */
  name?: string;
  /** Override the service address; tests use a local server. */
  baseUrl?: string;
  log(line: string): void;
  /** Ask the operator for a code shown on their phone; absent when nothing can prompt. */
  ask?(question: string): Promise<string>;
  signal: AbortSignal;
}

export interface ChannelCheck {
  name: string;
  ok: boolean;
  warnOnly?: boolean;
  detail: string;
}

export interface LoadResult {
  configs: Record<string, unknown>;
  /** Problems a person has to see; the channel still returns what it could parse. */
  problems: string[];
}

export interface MergeResult {
  configs: Record<string, unknown>;
  notes: string[];
}

/**
 * One entry per chat this instance has ever been seen in. `home` is learned once and
 * then left alone: whoever spoke last must not decide where an unprompted word lands.
 *
 * `channel`/`label`/`homeRank`/`canFile`/`canQuote` are absent in files written before
 * the channel contract existed; every reader treats that as Telegram, which is the
 * only channel that could have written them.
 */
export interface KnownChat {
  kind: "private" | "group";
  who?: string;
  title?: string;
  channel?: string;
  /** How the channel is named on the page ("微信"); empty for the original. */
  label?: string;
  /** Higher wins as home, first among equals. Absent: private 2, group 0. */
  homeRank?: number;
  canFile?: boolean;
  canQuote?: boolean;
}

export interface Chats {
  home?: number;
  known?: Record<string, KnownChat>;
}

/**
 * A place a waking may speak into. `channel` and the two capabilities come from the
 * channel that wrote the chat; they are what lets the book refuse a file or a quote
 * before it queues one, instead of the gateway dropping it after the tool said "sent".
 */
export interface Place {
  id: number;
  label: string;
  home: boolean;
  kind: "private" | "group";
  channel: string;
  canFile: boolean;
  canQuote: boolean;
}

/**
 * What came with a message. The channel only says how to fetch it; the core owns the
 * file's id, its name on disk and the size cap, so both transports name files the same.
 */
export interface RemoteAttachment {
  kind: Attachment["kind"];
  name?: string;
  bytes?: number;
  /** Why it is not here, when the channel chose not to fetch it (voice, no transcript). */
  note?: string;
  /** Absent when there is nothing to fetch; the core then keeps the note only. */
  download?: (dest: string) => Promise<number>;
}

/** The normalized inbound message the core can act on without knowing the wire. */
export interface Inbound {
  channel: string;
  channelLabel?: string;
  /** Stable across redelivery: `<chat>-<nativeId>` is the inbox file and the id. */
  nativeId: string;
  chat: number;
  chatKind: "private" | "group";
  chatTitle?: string;
  who?: string;
  /** Printed only for a guest, so the operator can add them to the allow list. */
  fromId?: string;
  text: string;
  at: string;
  allowed: boolean;
  isDm: boolean;
  isMention: boolean;
  isReply: boolean;
  listen: "all" | "mentions";
  /** Home priority: Telegram private 2, a reply-only private channel 1, group 0. */
  homeRank?: number;
  canFile?: boolean;
  canQuote?: boolean;
  quote?: Quoted;
  attachments: RemoteAttachment[];
}

export interface StartContext {
  root: string;
  instance: string;
  /** Read per message: a reload swaps the config under a running poller without moving it. */
  cfg(): unknown;
  /** The chat history as it is now, for the startup line and the default target. */
  chats: Chats | undefined;
  signal: AbortSignal;
  log(line: string): void;
  ops(line: string): void;
  onInbound(msg: Inbound): Promise<void>;
}

/** One thing a queued item still owes: a `/work` path the container named, or a host path. */
export interface SendStep {
  /** what goes back into the queue file when this step has not been sent yet */
  given: string;
  /** where the bytes actually are */
  path: string;
  name: string;
  kind: "work" | "file";
}

export interface SendContext {
  root: string;
  instance: string;
  cfg: unknown;
  /** Resolved by the core: the item's chat, the channel's pinned target, or home. */
  chat: number;
  item: OutboxItem;
  /** The upload half, already checked against `/work`; refused paths are not here. */
  steps: SendStep[];
  replyTo?: Quote;
  /**
   * Called after each part actually left. The core writes `people/<chat>.jsonl` here,
   * not after the whole item: a later failure must not un-say an earlier part.
   */
  onSent(part: { text: string; nativeId?: string }): void;
  log(line: string): void;
  ops(line: string): void;
}

export interface SendResult {
  ack: boolean;
  /** Number of `item.messages` entries fully sent; files are carried by `left`. */
  sent: number;
  error: Error | null;
  /** the upload steps still owed, when the failure was one of them */
  left?: { files: string[]; attachments: { path: string; name: string }[] };
  /** The channel is waiting (a reply window, a quota), not failing. Leave the item. */
  hold?: boolean;
}

export interface TypingContext {
  root: string;
  instance: string;
  cfg: unknown;
  chat: number;
}
