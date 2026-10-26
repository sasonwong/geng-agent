import type { Paths } from "./paths.ts";
import { readText } from "./state.ts";

/**
 * The system prompt is the constant half of waking up: where it is, and the two
 * interfaces. Nothing that the agent itself can change belongs here — see below.
 */
export function composeSystemPrompt(base: string, facts = ""): string {
  const near = facts.trim();
  // Everything in here changes only when the operator does something, so this prompt and
  // the tools block below it stay byte-identical from waking to waking. The identity it
  // wrote is not in here: it rewrites that file whenever it likes, which would invalidate
  // the cache in front of the tools for no gain.
  const parts = [base.trim()];
  if (near !== "") parts.push(near);
  return `${parts.join("\n\n")}\n`;
}

export function systemPromptFor(paths: Paths, facts = ""): string {
  const base = readText(paths.systemMd);
  if (base === null) {
    throw new Error(`没有系统提示词：${paths.systemMd}（部署漏了 deploy/SYSTEM.md）`);
  }
  return composeSystemPrompt(base, facts);
}
