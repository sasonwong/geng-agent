import type { Paths } from "./paths.ts";
import { readText } from "./state.ts";

/**
 * The system prompt is the constant half of waking up: where it is, what it can write
 * to, and how to leave a next-see-you. The identity it wrote is appended as the last
 * section — empty on the first waking, which is exactly right.
 */
const SELF_HEADING = "## 你写下的自己";

export function composeSystemPrompt(
  base: string,
  identity: string | null,
  facts = "",
): string {
  const near = facts.trim();
  // Order matters twice over: the two facts sit below the frame but above the self, and
  // everything above them changes only when the operator does something — so the tools
  // block, which sits right below this whole prompt, stays cacheable from waking to waking.
  const parts = [base.trim()];
  if (near !== "") parts.push(near);
  parts.push(`${SELF_HEADING}

${(identity ?? "").trim()}`);
  return `${parts.join("\n\n")}\n`;
}

export function systemPromptFor(paths: Paths, facts = ""): string {
  const base = readText(paths.systemMd);
  if (base === null) {
    throw new Error(`没有系统提示词：${paths.systemMd}（部署漏了 deploy/SYSTEM.md）`);
  }
  return composeSystemPrompt(base, readText(paths.identity), facts);
}
