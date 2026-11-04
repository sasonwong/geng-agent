import { resolve } from "node:path";

/**
 * Resolve a path the model chose and say whether it stays inside the one directory it is
 * allowed to write. Checked after resolution, not on the string: `/work/../state/x` is
 * still inside the container, and a prefix test on the raw text would pass it.
 *
 * Free of pi imports so a test can exercise it without the image.
 */
export function resolveUnder(root: string, to: string): string | null {
  const base = resolve(root);
  const dest = resolve(base, to);
  return dest === base || dest.startsWith(base + "/") ? dest : null;
}
