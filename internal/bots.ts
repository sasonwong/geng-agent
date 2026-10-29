import { join } from "node:path";
import { chmodSync, existsSync, renameSync, statSync, writeFileSync } from "node:fs";
import { readJson } from "./state.ts";
import type { BotConfig } from "./telegram.ts";

/**
 * `secrets/bots.json`, and the one place that reads or writes it.
 *
 * It used to be edited by hand and read in two different places with two different
 * shapes — which is how a hand-typed token becomes a 401 nobody sees and a missing
 * `allow` entry becomes an instance that never wakes. The file is a map of instance →
 * its bot, with `ops` as the one key that is not an instance.
 */
export type Bots = Record<string, BotConfig>;

const file = (root: string) => join(root, "secrets", "bots.json");

export function readBots(root: string): Bots {
  return readJson<Bots>(file(root), {});
}

/** Atomic, and 600: this file is nothing but tokens and ids. */
export function writeBots(root: string, bots: Bots): void {
  const path = file(root);
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(bots, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
  if (existsSync(path)) chmodSync(path, 0o600);
}

export interface BotSpec {
  token: string;
  listen?: "all" | "mentions";
  allow?: number[];
  chat?: number;
}

/** Add or replace one bot. Keeps the rest of the file exactly as it was. */
export function addBot(root: string, key: string, spec: BotSpec): Bots {
  const bots = readBots(root);
  const before = bots[key] ?? {};
  bots[key] = {
    ...before,
    token: spec.token,
    ...(spec.listen === undefined ? {} : { listen: spec.listen }),
    ...(spec.allow === undefined ? {} : { allow: spec.allow }),
    ...(spec.chat === undefined ? {} : { chat: spec.chat }),
  };
  writeBots(root, bots);
  return bots;
}

/**
 * Add or remove whitelist ids. Union, not replacement: a second call can only widen or
 * narrow explicitly, never silently drop the id that was there before.
 */
export function editAllow(root: string, key: string, add: number[], rm: number[]): Bots {
  const bots = readBots(root);
  const cfg = bots[key];
  if (!cfg) throw new Error(`bots.json 里没有 ${key}`);
  const now = new Set(cfg.allow ?? []);
  for (const id of add) now.add(id);
  for (const id of rm) now.delete(id);
  cfg.allow = [...now];
  writeBots(root, bots);
  return bots;
}

/** Problems a human would only find by noticing that nothing ever happens. */
export function botProblems(bots: Bots, hasInstance: (key: string) => boolean): string[] {
  const out: string[] = [];
  for (const [key, cfg] of Object.entries(bots)) {
    if (typeof cfg.token !== "string" || cfg.token.trim() === "") {
      out.push(`${key}：没有 token`);
    }
    if (cfg.listen !== undefined && cfg.listen !== "all" && cfg.listen !== "mentions") {
      out.push(`${key}：listen 只能是 all 或 mentions（现在 ${String(cfg.listen)}）`);
    }
    if (cfg.allow !== undefined && !Array.isArray(cfg.allow)) {
      out.push(`${key}：allow 必须是数字数组`);
    } else if (Array.isArray(cfg.allow) && cfg.allow.some((id) => !Number.isFinite(id))) {
      out.push(`${key}：allow 里有不是数字的 id`);
    }
    if (key !== "ops" && !hasInstance(key)) {
      out.push(`${key}：data/${key}/ 不存在，这个 bot 没有对应的实例`);
    }
    if (key === "ops" && typeof cfg.chat !== "number") {
      out.push("ops：没有 chat，运维消息发不出去");
    }
  }
  return out;
}

/** Plain words about what the file gives this instance, for status lines and doctor. */
export function describeBot(cfg: BotConfig | undefined): string {
  if (!cfg) return "没有 bot：只有它自己的闹钟能叫醒它";
  const allow =
    cfg.allow === undefined ? "不限" : cfg.allow.length === 0 ? "0 人（谁都进不来）" : `${cfg.allow.length} 人`;
  return `listen=${cfg.listen ?? "all"} allow=${allow}${cfg.chat === undefined ? "" : " 有默认 chat"}`;
}

/** 600 or the token is one `cat` away from anybody who can read the directory. */
export function modeOf(path: string): number | null {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return null;
  }
}
