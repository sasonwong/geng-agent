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
  return `[刚收到] ${who}：${text.length > 400 ? text.slice(0, 400) + "…" : text}`;
}
