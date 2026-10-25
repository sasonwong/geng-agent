import { spawn } from "node:child_process";
import { join } from "node:path";
import type { Policy } from "./policy.ts";
import { readJson } from "./state.ts";
import type { Env } from "./meta.ts";

/** The image the next cycle will actually run, by content id rather than by tag. */
export function imageId(policy: Policy): Promise<string | null> {
  if (policy.runner !== "docker") return Promise.resolve(null);
  return new Promise((resolve) => {
    const p = spawn("docker", ["image", "inspect", "--format", "{{.Id}}", policy.container.image], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let text = "";
    p.stdout.setEncoding("utf8");
    p.stdout.on("data", (c: string) => {
      text += c;
    });
    p.on("error", () => resolve(null));
    p.on("close", (code) => resolve(code === 0 ? text.trim() || null : null));
  });
}

export function packageVersion(root: string): string | null {
  return readJson<{ version?: string }>(join(root, "package.json"), {}).version ?? null;
}

/**
 * Stated as fact, without identifiers. The image id and the version are the daemon's
 * own bookkeeping, useless to something that can look neither up; all it needs to know
 * is that it woke into a different world than the one it fell asleep in.
 */
export function describeEnvChange(before: Env | undefined, now: Env): string | null {
  if (!before) return null; // first waking: nothing to compare against
  const changed =
    (before.imageId ?? null) !== (now.imageId ?? null) ||
    (before.version ?? null) !== (now.version ?? null);
  return changed ? "环境变了。" : null;
}
