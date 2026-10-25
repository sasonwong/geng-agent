import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SKIP = new Set(["node_modules", ".git", ".cache"]);

/**
 * How many files under `dir` were written since `sinceMs`. A count, never a judgement:
 * the page states it as a fact, and no decision is ever made from it.
 *
 * shortcut: bounded walk (cap entries); a workspace with millions of files will
 * undercount. Raise the cap or use find -newer if that ever happens.
 */
export function countTouched(dir: string, sinceMs: number, cap = 5000): number | null {
  let seen = 0;
  let touched = 0;
  const walk = (at: string): void => {
    if (seen >= cap) return;
    let names: string[];
    try {
      names = readdirSync(at);
    } catch {
      return;
    }
    for (const name of names) {
      if (seen >= cap) return;
      if (SKIP.has(name)) continue;
      const full = join(at, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      seen++;
      if (st.isDirectory()) walk(full);
      else if (st.mtimeMs > sinceMs) touched++;
    }
  };
  try {
    walk(dir);
  } catch {
    return null;
  }
  return touched;
}
