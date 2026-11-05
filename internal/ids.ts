import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Paths } from "./paths.ts";
import { readJson, writeJson } from "./fs.ts";

/**
 * Every id in the book, handed out from one place.
 *
 * One letter decides where an id lives — J journal, L loop, P person, M message,
 * E email, R round, F file — so a reader never has to try four places to find out what
 * it is holding. The number after the letter is permanent: a name that gets reused is a
 * name that silently renamed an old entry.
 */
export type IdKind = "journal" | "loop" | "mail" | "file";

interface Ids {
  journalDay?: string;
  journalN?: number;
  loopN?: number;
  mailN?: number;
  fileN?: number;
}

function today(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10).replace(/-/g, "");
}

/** The highest number already used in these directories, or 0. */
function highest(dirs: string[], pattern: RegExp): number {
  let max = 0;
  for (const dir of dirs) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const m = pattern.exec(name);
      if (m?.[1] !== undefined) max = Math.max(max, Number(m[1]) || 0);
    }
  }
  return max;
}

/**
 * The next id of a series: one past the highest number *ever handed out*.
 *
 * Looking only at the files is not enough: delete the newest entry and the next write
 * reuses its name, silently renaming an old entry. The ceiling is remembered in
 * `meta/ids.json` and the files are only the floor — they can raise it (a restored
 * snapshot has ids the counter has not seen) but not lower it.
 */
export function allocate(paths: Paths, kind: IdKind): { id: string; n: number; day: string } {
  const ids = readJson<Ids>(paths.ids, {});
  const day = today(Date.now());
  if (kind === "loop") {
    const floor = highest([paths.openLoops, join(paths.openLoops, "closed")], /^L(\d+)\.md$/);
    const n = Math.max(ids.loopN ?? 0, floor) + 1;
    writeJson(paths.ids, { ...ids, loopN: n });
    return { id: `L${n}`, n, day };
  }
  if (kind === "mail") {
    const floor = highest([paths.mail], /^E(\d+)-/);
    const n = Math.max(ids.mailN ?? 0, floor) + 1;
    writeJson(paths.ids, { ...ids, mailN: n });
    return { id: `E${n}`, n, day };
  }
  if (kind === "file") {
    const floor = highest([paths.filesDir], /^F(\d+)-/);
    const n = Math.max(ids.fileN ?? 0, floor) + 1;
    writeJson(paths.ids, { ...ids, fileN: n });
    return { id: `F${n}`, n, day };
  }
  const floor = highest([paths.journal, paths.journalDiscarded], new RegExp(`^J${day}-(\\d+)\\.md$`));
  const n = Math.max(ids.journalDay === day ? (ids.journalN ?? 0) : 0, floor) + 1;
  writeJson(paths.ids, { ...ids, journalDay: day, journalN: n });
  return { id: `J${day}-${n}`, n, day };
}

/** `F12` → the file it names in this instance's `files/`, or null if there is none. */
export function fileById(paths: Paths, id: string): { name: string; path: string } | null {
  const m = /^F(\d+)$/.exec(id.trim());
  if (!m) return null;
  let names: string[];
  try {
    names = readdirSync(paths.filesDir);
  } catch {
    return null;
  }
  const prefix = `${m[0]}-`;
  const name = names.find((n) => n.startsWith(prefix));
  return name === undefined ? null : { name, path: join(paths.filesDir, name) };
}

/** Every file that has an id, newest first, for `recall`. */
export function listFiles(paths: Paths): { id: string; name: string; bytes: number }[] {
  let names: string[];
  try {
    names = readdirSync(paths.filesDir);
  } catch {
    return [];
  }
  return names
    .map((name) => {
      // the file name is `<id>-<index>-<original>`; the index exists only because one
      // mail may carry two files with the same name
      const m = /^(F\d+)-\d+-(.*)$/.exec(name);
      if (!m) return null;
      let bytes = 0;
      try {
        bytes = statSync(join(paths.filesDir, name)).size;
      } catch {
        return null;
      }
      return { id: m[1] as string, name: m[2] as string, bytes };
    })
    .filter((f): f is { id: string; name: string; bytes: number } => f !== null);
}
