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
 * Stated as fact, without advice: the tool list comes from the image, so a rebuild
 * can have added or removed tools, and only it can decide what that means.
 */
export function describeEnvChange(before: Env | undefined, now: Env): string | null {
  if (!before) return null; // first waking: there is nothing to compare against
  const parts: string[] = [];
  if (before.imageId && now.imageId && before.imageId !== now.imageId) {
    parts.push(`镜像 ${before.imageId.replace("sha256:", "").slice(0, 8)} → ${now.imageId.replace("sha256:", "").slice(0, 8)}`);
  }
  if (before.version && now.version && before.version !== now.version) {
    parts.push(`程序 ${before.version} → ${now.version}`);
  }
  return parts.length > 0 ? `环境变了：${parts.join("，")}。` : null;
}
