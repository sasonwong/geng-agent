import { readFileSync, writeFileSync } from "node:fs";

export interface TailReport {
  file: string;
  lines: number;
  repairedLines: number;
  note: string;
}

/**
 * A SIGKILL mid-append can leave a partial final line. Everything after the
 * last line that parses as JSON is dropped — better to lose one entry than to
 * feed a corrupt record into context rebuilding forever.
 */
export function repairTail(file: string, fix: boolean): TailReport {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return { file, lines: 0, repairedLines: 0, note: "unreadable" };
  }
  const lines = text.split("\n");
  // A trailing newline produces a final "" element; that is not a broken line.
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  let lastGood = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      JSON.parse(lines[i] as string);
      lastGood = i;
      break;
    } catch {
      // keep walking backwards
    }
  }
  const drop = lines.length - (lastGood + 1);
  const note = drop === 0 ? "ok" : `${drop} 行尾部损坏`;
  if (drop > 0 && fix) {
    writeFileSync(file, lines.slice(0, lastGood + 1).join("\n") + "\n", "utf8");
  }
  return { file, lines: lines.length, repairedLines: fix ? drop : 0, note };
}

export interface ModelFailures {
  count: number;
  /** Whether the last thing it said was an error rather than words. */
  last: boolean;
}

/**
 * How many of the round's model requests came back as an error.
 *
 * pi retries a failed request and records each attempt as an empty assistant message with
 * `stopReason: "error"`, then settles normally — so a round in which the provider was
 * gone looks exactly like a round that thought hard and chose to say nothing. The RPC
 * stream carries no event for it (only `agent_settled`), and the session file is the only
 * place the failure was written down. Counting it is not a judgement: it is a number the
 * provider already produced.
 */
export function modelFailures(file: string): ModelFailures {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return { count: 0, last: false };
  }
  let count = 0;
  let last = false;
  for (const line of text.split("\n")) {
    if (line === "") continue;
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // a partial tail line: repairTail's problem, not this one
    }
    const message = (rec as { message?: { role?: string; stopReason?: string } }).message;
    if (message?.role !== "assistant") continue;
    const failed = message.stopReason === "error";
    if (failed) count += 1;
    last = failed;
  }
  return { count, last };
}
