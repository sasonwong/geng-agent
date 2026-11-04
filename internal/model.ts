import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Paths } from "./paths.ts";
import { readEnvFile } from "./secret.ts";

/**
 * The model key lives on the host, in a file the container never sees.
 *
 * It used to ride in `secrets/<inst>.env`, which is `--env-file` into the container: one
 * round ran `env` and could have read it. Now pi asks for it at request time —
 * `models.json` carries `apiKey: "!curl … /model/key"` — so the key exists on the host,
 * on the wire to the provider, and nowhere the agent can look.
 */
export const MODEL_KEY_VARS = ["GENG_MODEL_KEY", "OPENCODE_API_KEY", "DEEPSEEK_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"];

export function modelKeyFile(p: Paths): string {
  return join(p.root, "secrets", "model.env");
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
