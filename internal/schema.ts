import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Paths } from "./paths.ts";
import { readJson, writeJson } from "./state.ts";

/**
 * The version of the files the daemon writes. Bump it when a shape changes, never when a
 * field is merely added: a reader ignores what it does not know, so additions need no
 * migration and no reset.
 */
export const STATE_SCHEMA = 1;

export function onDiskSchema(paths: Paths): number | null {
  const file = join(paths.meta, "state.json");
  const raw = readJson<{ stateSchema?: unknown } | null>(file, null);
  if (raw === null) return null; // no life yet
  // a file without the stamp was written before versioning: older, not unknown
  return typeof raw.stateSchema === "number" ? raw.stateSchema : 0;
}

/**
 * A life written by a newer build must not be run by an older one: a missing field is
 * survivable, a field the older code would overwrite from its own idea of the shape is
 * not. Refusing is the only answer that cannot lose anything.
 */
export function schemaConflict(found: number | null): string | null {
  if (found === null || found === STATE_SCHEMA) return null;
  if (found > STATE_SCHEMA) {
    return `这个生命是更新版本写的（stateSchema ${found} > ${STATE_SCHEMA}）：不要用旧代码跑它。`;
  }
  return null; // older: readable, and a migration can upgrade it when one exists
}

/**
 * policy.json used to live in the book it governs, mounted read-only to stop it editing
 * it. Moving the file out of the mount is the honest fix; this carries an old instance over.
 */
export function ensurePolicyLocation(paths: Paths): void {
  const old = join(paths.palimpsest, "policy.json");
  if (!existsSync(old)) return;
  if (!existsSync(paths.policy)) writeJson(paths.policy, readJson<unknown>(old, {}));
  rmSync(old, { force: true });
}
