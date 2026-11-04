import { appendLine } from "./state.ts";
import type { ToolCall } from "./rpc.ts";

/**
 * One line per tool call: what the round did, in the order it did it.
 *
 * This exists because every count the page will ever show has to come from somewhere
 * countable, and "how much of its memory traffic goes through a named tool" is the one
 * number that decides whether memory as a tool surface is worth building. Before this,
 * a round that wrote three journal entries and one that ran `ls` three times produced
 * the same number: `tools=3`.
 *
 * It is an index, not a fact: `session/` holds the same calls and can rebuild it.
 */
export interface ActLine {
  /** ISO, from the clock at the moment the action started. */
  at: string;
  /** Which waking this belonged to — the first half of `R212/T7`. */
  waking: number;
  /** 1-based position within the round. */
  seq: number;
  tool: string;
  ms: number | null;
  err: boolean;
  /** The arguments, truncated the same way the repeat watcher truncates them. */
  preview: string;
}

export function actsFor(waking: number, calls: ToolCall[]): ActLine[] {
  return calls.map((c, i) => ({
    at: new Date(c.atMs).toISOString(),
    waking,
    seq: i + 1,
    tool: c.name,
    ms: c.durationMs,
    err: c.isError,
    preview: c.preview,
  }));
}

export function appendActs(file: string, lines: ActLine[]): void {
  for (const line of lines) appendLine(file, JSON.stringify(line));
}

/**
 * How many actions mentioned the book at all.
 *
 * Lower bound on purpose: `preview` is the arguments cut at 120 characters, so a path
 * late in a long argument is invisible here. That is acceptable for the number it is
 * used for — "how much memory traffic has no name yet" — because a tool call carries
 * what it is in its *name*, so the count only has to be big enough to make the point,
 * not exact.
 */
