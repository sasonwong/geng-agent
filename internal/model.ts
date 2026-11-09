import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Paths } from "./paths.ts";
import { readEnvFile } from "./secret.ts";

/**
 * The model key lives on the host, in a file the container never sees.
 *
 * It used to ride in `secrets/<inst>.env`, which is `--env-file` into the container: one
 * round ran `env` and could have read it. Now pi posts to `127.0.0.1:11434/model` and the
 * daemon adds the credential on the way out, so the key exists on the host, on the wire
 * to the provider, and nowhere the agent can look.
 */
export const MODEL_KEY_VARS = ["GENG_MODEL_KEY", "OPENCODE_API_KEY", "DEEPSEEK_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"];

/**
 * Everything that lives in the per-instance model file: the key, and the upstream the
 * proxy needs to reach the provider. `modelUpstream()` reads GENG_MODEL_UPSTREAM out of
 * that file, so a writer that files it under `secrets/<inst>.env` instead writes a value
 * nothing ever reads — and hands the container a copy of it into the bargain.
 */
export const MODEL_FILE_VARS = [...MODEL_KEY_VARS, "GENG_MODEL_UPSTREAM"];

/**
 * One key file per instance, not one for the machine.
 *
 * It was `secrets/model.env` while there was one instance to run; a second instance would
 * have had to share its provider and its key, which is a coupling nobody chose and nothing
 * reported. `init` writes it, so two instances are two decisions.
 */
export function modelKeyFile(p: Paths): string {
  return join(p.root, "secrets", `${p.instance}.model.env`);
}

/** Where the provider lives. The proxy needs this; pi no longer knows the address. */
export function modelUpstream(p: Paths): string | null {
  const file = modelKeyFile(p);
  if (!existsSync(file)) return null;
  const value = (readEnvFile(file).GENG_MODEL_UPSTREAM ?? "").trim();
  return value === "" ? null : value;
}

export function readModelKey(p: Paths): { name: string; key: string } | null {
  const file = modelKeyFile(p);
  if (!existsSync(file)) return null;
  const env = readEnvFile(file);
  for (const name of MODEL_KEY_VARS) {
    const key = (env[name] ?? "").trim();
    if (key !== "") return { name, key };
  }
  return null;
}

/** One provider's key by name, for a chain entry that names a different vendor. */
export function readNamedModelKey(p: Paths, name: string): string | null {
  const file = modelKeyFile(p);
  if (!existsSync(file)) return null;
  const key = (readEnvFile(file)[name] ?? "").trim();
  return key === "" ? null : key;
}

/**
 * Where a provider lives, and which key it wants.
 *
 * This is the one fact the old layout could not hold: `GENG_MODEL_UPSTREAM` is a single
 * address, so a fallback that crossed to another vendor had nowhere to say where that
 * vendor is. It stays a fallback for instances that were born before this file existed —
 * file over environment, the same order `search.ts` uses.
 *
 * The container never sees this file: it is not mounted, and knowing an address is not
 * the same as being able to use it, but there is no reason to tell it either.
 */
export interface ModelProvider {
  url: string;
  /** The variable holding this provider's key; absent means "whichever this instance has". */
  key?: string;
}

export interface ModelChainEntry {
  provider: string;
  model: string;
  /** Sent as the request's `reasoning_effort`; absent leaves what pi already chose. */
  reasoningEffort?: string;
}

const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]*$/i;
/** The wire values `reasoning_effort` takes. `off` is not one: pi drops the field instead. */
const EFFORT_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"];
const CHAIN_KEYS = ["provider", "model", "reasoningEffort"];

function httpUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/\/+$/, "");
  return /^https?:\/\/[^\s/?#]+/.test(trimmed) ? trimmed : null;
}

export function readProviders(p: Paths): { table: Record<string, ModelProvider>; error: string | null } {
  const file = p.providers;
  if (!existsSync(file)) return { table: {}, error: null };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    return { table: {}, error: `${file} 不是 JSON：${(err as Error).message}` };
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { table: {}, error: `${file} 要一个对象：provider 名 → 地址` };
  }
  const table: Record<string, ModelProvider> = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    const at = typeof value === "string" ? value : (value as { url?: unknown } | null)?.url;
    const url = httpUrl(at);
    if (url === null) return { table, error: `${file} 里 ${id} 的地址要是 http(s) URL` };
    const key = typeof value === "object" && value !== null ? (value as { key?: unknown }).key : undefined;
    if (key !== undefined && (typeof key !== "string" || !MODEL_KEY_VARS.includes(key))) {
      return { table, error: `${file} 里 ${id} 的 key 要是 ${MODEL_KEY_VARS.join(" / ")} 之一，拿到 ${JSON.stringify(key)}` };
    }
    table[id] = key === undefined ? { url } : { url, key };
  }
  return { table, error: null };
}

function chainParts(provider: string, model: string, shown: string): ModelChainEntry | string {
  if (provider === "") return `要写成 "provider/model"，例如 "opencode-go/beam-free"`;
  if (!PROVIDER_ID.test(provider)) return `provider 名不对：${provider}`;
  if (model === "") return `缺模型名：${shown}`;
  return { provider, model };
}

function chainEntry(item: unknown): ModelChainEntry | string {
  if (typeof item === "string") {
    const at = item.indexOf("/");
    if (at < 0) return `要写成 "provider/model"，例如 "opencode-go/beam-free"`;
    return chainParts(item.slice(0, at).trim(), item.slice(at + 1).trim(), item);
  }
  if (item === null || typeof item !== "object" || Array.isArray(item)) {
    return `要写成 "provider/model" 或 { "provider", "model" } 对象，拿到 ${JSON.stringify(item)}`;
  }
  const fields = item as Record<string, unknown>;
  const unknown = Object.keys(fields).filter((key) => !CHAIN_KEYS.includes(key));
  if (unknown.length > 0) return `不认识的键 ${unknown.join("、")}，只认 ${CHAIN_KEYS.join(" / ")}`;
  const provider = typeof fields.provider === "string" ? fields.provider.trim() : "";
  const model = typeof fields.model === "string" ? fields.model.trim() : "";
  const entry = chainParts(provider, model, `${provider}/${model}`);
  if (typeof entry === "string") return entry;
  const effort = fields.reasoningEffort;
  if (effort === undefined) return entry;
  if (typeof effort !== "string" || !EFFORT_LEVELS.includes(effort)) {
    return `reasoningEffort 要 ${EFFORT_LEVELS.join(" / ")} 之一（off 不在这里：要关思考就改主力的 defaultThinkingLevel），拿到 ${JSON.stringify(effort)}`;
  }
  return { ...entry, reasoningEffort: effort };
}

/** `a/b,c/d` as the CLI takes it: one flag, one list, the first one is the primary. */
export function chainFromSpec(spec: string): ModelChainEntry[] {
  const items = spec.split(",").map((s) => s.trim()).filter((s) => s !== "");
  if (items.length === 0) throw new Error("--chain 不能是空的");
  const out: ModelChainEntry[] = [];
  for (const item of items) {
    const entry = chainEntry(item);
    if (typeof entry === "string") throw new Error(`--chain 里 ${item}：${entry}`);
    out.push(entry);
  }
  return out;
}

/**
 * The chain file as written. A file that does not parse is reported, not obeyed: the
 * caller decides whether that means 503 or "carry on without fallback", and the doctor is
 * what keeps it from being silent.
 */
export function readChain(p: Paths): { chain: ModelChainEntry[]; error: string | null } {
  const file = p.modelChain;
  if (!existsSync(file)) return { chain: [], error: null };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    return { chain: [], error: `${file} 不是 JSON：${(err as Error).message}` };
  }
  if (!Array.isArray(raw)) return { chain: [], error: `${file} 要一个数组，第一条是主力模型` };
  const chain: ModelChainEntry[] = [];
  for (const item of raw) {
    const entry = chainEntry(item);
    if (typeof entry === "string") return { chain, error: `${file}：${entry}` };
    chain.push(entry);
  }
  return { chain, error: null };
}
