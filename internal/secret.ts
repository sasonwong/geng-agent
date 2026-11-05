import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ExpectedError } from "./errors.ts";
import type { MailConfig, MailEnv } from "./mail.ts";
import { MODEL_FILE_VARS } from "./model.ts";

/**
 * Env files under `secrets/`, and the values that have to match something outside this
 * repo: the mail token the Worker also holds, the bot token Telegram issued, the GitHub
 * App's two ids. A mismatch is the worst kind of wrong — one side looks fine, the other
 * quietly does nothing, and no log says which.
 */

/**
 * 一行 `.env` 拆成键和值。手写文件最常见的 `export NAME=value` 在这里把前缀剥掉：
 * 读和写共用这一把尺子，否则 `export NAME` 与 `NAME` 会被当成两个不同的键，
 * 后者写进去也盖不住前者。注释、空行、没有等号的行返回 null。
 */
function parseEnvLine(raw: string): { key: string; value: string } | null {
  const line = raw.trim().replace(/^export\s+/i, "");
  if (line === "" || line.startsWith("#")) return null;
  const at = line.indexOf("=");
  if (at === -1) return null;
  return { key: line.slice(0, at).trim(), value: line.slice(at + 1).trim() };
}

export function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const parsed = parseEnvLine(raw);
    if (parsed !== null) out[parsed.key] = parsed.value;
  }
  return out;
}

/**
 * Replace one `NAME=value` line, or append it. Comments and every other line stay
 * exactly where they were: this file is the operator's, not ours.
 */
export function writeEnvValue(path: string, name: string, value: string): void {
  // 值里带换行会往 .env 里偷偷塞进额外的一行，而 readEnvFile 又是后写覆盖前写：
  // 一次 `secrets set` 就能凭空写出第二把 GENG_MODEL_KEY。写之前先挡住。
  if (/[\r\n]/.test(value)) {
    throw new ExpectedError(`secrets: ${name} 的值不能包含换行符（\\n / \\r），那会注入额外的 env 行`);
  }
  const lines = existsSync(path) ? readFileSync(path, "utf8").split("\n") : [];
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  let replaced = false;
  const out: string[] = [];
  for (const raw of lines) {
    const parsed = parseEnvLine(raw);
    const isMatch = parsed !== null && parsed.key === name;
    if (!isMatch) {
      out.push(raw);
      continue;
    }
    // readEnvFile 是后写覆盖前写：只改第一行，后面那行旧值反而在写完之后赢。
    // 只留第一次出现的那行写新值，其余同名行全部丢掉。export NAME 与 NAME 在这里
    // 是同一个键，一并折叠成一行。
    if (!replaced) {
      out.push(`${name}=${value}`);
      replaced = true;
    }
  }
  if (!replaced) out.push(`${name}=${value}`);
  // a fresh root has no secrets/ yet, and a hand-run `secrets set` is how it gets one
  mkdirSync(dirname(path), { recursive: true });
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
  return MODEL_FILE_VARS.includes(name)
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
