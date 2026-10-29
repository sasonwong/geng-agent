import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MailConfig, MailEnv } from "./mail.ts";

/**
 * Env files under `secrets/`, and the three values that have to be identical in two
 * places. A mismatch there is the worst kind of wrong: one side works, the other side
 * quietly does nothing, and nothing in any log says which.
 */

export function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const at = line.indexOf("=");
    if (at === -1) continue;
    out[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return out;
}

/**
 * Replace one `NAME=value` line, or append it. Comments and every other line stay
 * exactly where they were: this file is the operator's, not ours.
 */
export function writeEnvValue(path: string, name: string, value: string): void {
  const lines = existsSync(path) ? readFileSync(path, "utf8").split("\n") : [];
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  let replaced = false;
  const out = lines.map((raw) => {
    if (replaced) return raw;
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return raw;
    const at = line.indexOf("=");
    if (at === -1 || line.slice(0, at).trim() !== name) return raw;
    replaced = true;
    return `${name}=${value}`;
  });
  if (!replaced) out.push(`${name}=${value}`);
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, out.join("\n") + "\n", { mode: 0o600 });
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

/** Same shape the docs use (`openssl rand -hex 16`), so an operator can regenerate one by hand. */
export function newToken(): string {
  return randomBytes(16).toString("hex");
}

export interface SecretInput {
  root: string;
  instance: string;
  instEnv: Record<string, string>;
  searchEnv: Record<string, string>;
  mailEnv: MailEnv | null;
  mail: MailConfig | null;
}

/** An instance without a model key fails its first waking; nothing else here matters then. */
export function envProblem(instEnv: Record<string, string>): string | null {
  const has = Object.keys(instEnv).some((k) => k.endsWith("_API_KEY") && instEnv[k] !== "");
  return has ? null : "没有任何 *_API_KEY（init 只放空模板，这一项要你填）";
}

/**
 * The search endpoint and the container each hold a token. They are the same string or
 * the container's `web_search` returns 401 forever, and the page still says it exists.
 */
export function searchPairProblem(
  instEnv: Record<string, string>,
  searchEnv: Record<string, string>,
): string | null {
  const url = instEnv.GENG_SEARCH_URL ?? "";
  const mine = instEnv.GENG_SEARCH_TOKEN ?? "";
  const theirs = searchEnv.GENG_SEARCH_TOKEN ?? "";
  if (url === "" && mine === "") return null;
  if (url === "") return "有 GENG_SEARCH_TOKEN 却没有 GENG_SEARCH_URL";
  if (mine === "") return "有 GENG_SEARCH_URL 却没有 GENG_SEARCH_TOKEN";
  if (theirs === "") return "实例里有 token，secrets/search.env 里没有";
  return mine === theirs ? null : "两处 GENG_SEARCH_TOKEN 不一致";
}

/** A mailbox needs both halves, and each one alone fails silently. */
export function mailWiringProblem(
  instance: string,
  mail: MailConfig | null,
  mailEnv: MailEnv | null,
): string | null {
  const mine = mail === null ? [] : Object.keys(mail).filter((a) => mail[a]?.instance === instance);
  if (mine.length === 0 && mailEnv === null) return null;
  if (mailEnv === null) return "secrets/mail.json 里有这个实例的地址，但 mail.env 没有 token";
  if (mine.length === 0) return "有邮件 token，但 mail.json 里没有地址指向这个实例";
  return null;
}

/** Which files this instance's secrets live in, for "where do I put it" messages. */
export function secretFiles(root: string, instance: string): { inst: string; search: string; mail: string } {
  return {
    inst: join(root, "secrets", `${instance}.env`),
    search: join(root, "secrets", "search.env"),
    mail: join(root, "secrets", "mail.env"),
  };
}
