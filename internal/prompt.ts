import type { Paths } from "./paths.ts";
import { readText } from "./state.ts";

/**
 * The system prompt is the constant half of waking up: where it is, what it can write
 * to, and how to leave a next-see-you. The identity it wrote is appended as the last
 * section — empty on the first waking, which is exactly right.
 */
export function composeSystemPrompt(base: string, identity: string | null): string {
  const self = (identity ?? "").trim();
  return `${base.trimEnd()}\n\n${self === "" ? "" : self + "\n"}`;
}

export function systemPromptFor(paths: Paths): string {
  const base = readText(paths.systemMd);
  if (base === null) {
    throw new Error(`没有系统提示词：${paths.systemMd}（部署漏了 deploy/SYSTEM.md）`);
  }
  return composeSystemPrompt(base, readText(paths.identity));
}
