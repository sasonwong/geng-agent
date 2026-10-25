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
