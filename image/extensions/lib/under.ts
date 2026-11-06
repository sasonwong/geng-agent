import { lstatSync } from "node:fs";
import { posix } from "node:path";

/**
 * Resolve a path the model chose and say whether it stays inside the one directory it is
 * allowed to write. Checked after resolution, not on the string: `/work/../state/x` is
 * still inside the container, and a prefix test on the raw text would pass it.
 *
 * The container is always Linux, so this reasons in POSIX path semantics even when a
 * test runs it on a machine whose `resolve()` would use `\` and a drive letter.
 *
 * Free of pi imports so a test can exercise it without the image.
 */
export function resolveUnder(root: string, to: string): string | null {
  const base = posix.resolve(root);
  const dest = posix.resolve(base, to);
  if (dest !== base && !dest.startsWith(base + posix.sep)) return null;

  // `/work` survives between wakings and the model can write to it. A symlink left there
  // last round would make an "inside /work" answer land somewhere else entirely when
  // `download` follows it. Every component that already exists is checked; a missing one is
  // fine (the download creates it), anything else is not.
  let cursor = base;
  const rel = dest === base ? [] : dest.slice(base.length + posix.sep.length).split(posix.sep);
  for (const part of ["", ...rel]) {
    if (part !== "") cursor = posix.resolve(cursor, part);
    try {
      if (lstatSync(cursor).isSymbolicLink()) return null;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") return null;
    }
  }
  return dest;
}
