import { attachmentWords } from "./attach.ts";

/**
 * A message that arrives while a waking is running can be handed to it mid-flight
 * instead of waiting for the next one. Only messages the gateway marked as a knock:
 * the group chatter that belongs in the quiet bucket must not interrupt work.
 */
export interface LiveMsg {
  id: string;
  file: string;
  text: string;
  from?: string;
  /** What came with it: a message may be nothing but a file. */
  attachments?: { kind: string; path?: string; note?: string; bytes?: number }[];
}

/** How many messages may be pushed into one waking. Beyond this they wait. */
export const INJECT_CAP = 6;

export function freshForSteer(pending: LiveMsg[], shown: Set<string>, room: number): LiveMsg[] {
  if (room <= 0) return [];
  return pending.filter((m) => !shown.has(m.id)).slice(0, room);
}

/** A fact with an author, no advice: it interrupts a working turn, so keep it bare. */
export function injectionText(m: LiveMsg): string {
  const who = m.from ?? "有人";
  const text = m.text.replace(/\s+/g, " ").trim();
  if (text === "") {
    // a photo, a document or a voice note often comes with nothing typed; "empty"
    // would read as a glitch rather than as something that needs a look
    const carried = m.attachments ?? [];
    const what = carried.length === 1 ? attachmentWords(carried[0]!) : `${carried.length} 个附件`;
    return `[刚收到] ${who}：没写字，只带了 ${what}。`;
  }
  return `[刚收到] ${who}：${text.length > 400 ? text.slice(0, 400) + "…" : text}`;
}

/**
 * Which injected messages were actually read, and how many were handed over at all. Same
 * order on both sides: the drain hands them over in order and rpc records them in order.
 * An empty file is a clock notice, not a message: it stands in the list only to keep the
 * two sides paired by index, and there is nothing on disk to mark as seen.
 */
export function handedOver(
  injected: { file: string }[],
  records: { read: boolean }[],
): { files: string[]; total: number; unread: number; clock: number } {
  const files: string[] = [];
  let total = 0;
  let unread = 0;
  let clock = 0;
  injected.forEach((m, i) => {
    if (m.file === "") {
      clock += 1;
      return;
    }
    total += 1;
    if (records[i]?.read === true) files.push(m.file);
    else unread += 1;
  });
  return { files, total, unread, clock };
}

/** How much of the round is left when the warning is due, in minutes. Not policy. */
export const CLOCK_MINUTES = 5;

/** A round with barely more than the warning in it gets no warning: it is already over. */
const CLOCK_MARGIN_MS = 60_000;

/**
 * One line per waking, said the first time the drain runs inside the last five minutes.
 * "约" rather than "还剩": the steer lands between two actions, so it can be a few seconds
 * late, and a notice that claims a precision it does not have is worse than a rough one.
 *
 * A short round (a budget that does not outlast the margin) is skipped on purpose: with a
 * three-minute budget the line would fire at the start, which is noise, not a warning.
 */
export function clockNotice(leftMs: number, instance: string, said: Set<number>): string[] {
  const mark = CLOCK_MINUTES;
  if (said.has(mark) || leftMs > mark * 60_000) return [];
  said.add(mark);
  return [`[daemon@${instance}] 本轮还剩约 ${mark} 分钟`];
}

/** Whether a budget is long enough for the warning to mean anything (see clockNotice). */
export function clockArmed(budgetMs: number): boolean {
  return budgetMs >= CLOCK_MINUTES * 60_000 + CLOCK_MARGIN_MS;
}
