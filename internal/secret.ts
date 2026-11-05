import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MailConfig, MailEnv } from "./mail.ts";
import { MODEL_KEY_VARS } from "./model.ts";

/**
 * Env files under `secrets/`, and the values that have to match something outside this
 * repo: the mail token the Worker also holds, the bot token Telegram issued, the GitHub
 * App's two ids. A mismatch is the worst kind of wrong — one side looks fine, the other
 * quietly does nothing, and no log says which.
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

/**
 * Where one `NAME` belongs. A model key in `secrets/<inst>.env` is a key the container can
 * read out of its own environment — that file is `--env-file`, and the whole point of the
 * proxy is that the key is not in it. The two live in different files, so the writer has
 * to know which one it is writing.
 */
export function secretFileFor(root: string, instance: string, name: string): string {
  return MODEL_KEY_VARS.includes(name)
    ? join(root, "secrets", `${instance}.model.env`)
    : join(root, "secrets", `${instance}.env`);
}

/** Which files this instance's secrets live in, for "where do I put it" messages. */
export function secretFiles(root: string, instance: string): { inst: string; search: string; mail: string } {
  return {
    inst: join(root, "secrets", `${instance}.env`),
    search: join(root, "secrets", "search.env"),
    mail: join(root, "secrets", "mail.env"),
  };
}
