import { randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { makePaths, requiredDirs } from "./paths.ts";
import { readJson } from "./fs.ts";

// Everything in this file is `--env-file` into the container, so nothing secret goes here.
// It holds only what the container is allowed to see: the two GitHub App ids.
const SECRETS_TEMPLATE = `# geng: things the container is allowed to see.
# Injected with \`docker run --env-file\` — never mounted, never in data/, never in backups.
# The model key does NOT belong here: it goes in secrets/<instance>.model.env, which the container
# never reads (pi posts to the daemon, which adds the key). Nothing here is a credential
# to anything outside: it is what the container is allowed to see.
`;

export const DEFAULT_UPSTREAM = "https://opencode.ai/inference/go/v1";

// Not injected anywhere: the daemon reads it and answers /model, so the container can use
// the key without being able to read it.
function modelEnvText(key: string, upstream: string): string {
  return `# geng: the provider key for this instance's model.
# The container never sees this file: pi posts to the daemon, which adds the key.
OPENCODE_API_KEY=${key}
# Where the provider lives. The proxy forwards here; pi is pointed at localhost instead.
GENG_MODEL_UPSTREAM=${upstream}
`;
}

/**
 * What the operator decided, written down once, here.
 *
 * Everything else is copied from `deploy/`. These are the four values that are about this
 * instance and not about the project: which image, how long a round may run, which model,
 * and where that model lives.
 */
export interface InitOptions {
  image?: string;
  timeoutMin?: number;
  model?: string;
  upstream?: string;
  /** Taken from the environment: nobody should have to open a file to paste a key. */
  modelKey?: string;
}

export function initInstance(root: string, instance: string, opts: InitOptions = {}): void {
  const p = makePaths(root, instance);
  for (const d of requiredDirs(p)) mkdirSync(d, { recursive: true });

  // daemon.log is bind-mounted into the container: docker creates a *directory* for a
  // missing host path, and then every line the daemon tries to append fails with EISDIR.
  if (!existsSync(p.daemonLog)) writeFileSync(p.daemonLog, "");

  const policyTemplate = join(root, "deploy", "policy.json");
  if (!existsSync(p.policy) && existsSync(policyTemplate)) {
    mkdirSync(dirname(p.policy), { recursive: true });
    copyFileSync(policyTemplate, p.policy);
  }

  const settingsTemplate = join(root, "deploy", "settings.json");
  const settingsFile = join(p.piDir, "settings.json");
  if (!existsSync(settingsFile) && existsSync(settingsTemplate)) {
    copyFileSync(settingsTemplate, settingsFile);
  }
  // The template is the project's default; a value given here is this instance's answer.
  // Only keys the instance actually owns are touched — the rest stays the template's.
  if (existsSync(p.policy) && (opts.image !== undefined || opts.timeoutMin !== undefined)) {
    const policy = readJson<Record<string, Record<string, unknown>>>(p.policy, {});
    if (opts.image !== undefined) policy.container = { ...policy.container, image: opts.image };
    if (opts.timeoutMin !== undefined) {
      policy.cycle = { ...policy.cycle, timeoutSec: opts.timeoutMin * 60 };
    }
    writeFileSync(p.policy, `${JSON.stringify(policy, null, 2)}\n`);
  }
  if (existsSync(settingsFile) && opts.model !== undefined) {
    const settings = readJson<Record<string, unknown>>(settingsFile, {});
    writeFileSync(settingsFile, `${JSON.stringify({ ...settings, defaultModel: opts.model }, null, 2)}\n`);
  }

  if (!existsSync(p.secrets)) {
    mkdirSync(dirname(p.secrets), { recursive: true });
    writeFileSync(p.secrets, SECRETS_TEMPLATE, { mode: 0o600 });
  }
  chmodSync(p.secrets, 0o600);

  // Per instance: two instances may talk to two providers with two keys, and one shared
  // file would have made that impossible without a migration later.
  const modelEnv = join(root, "secrets", `${instance}.model.env`);
  if (!existsSync(modelEnv)) {
    writeFileSync(modelEnv, modelEnvText(opts.modelKey ?? "", opts.upstream ?? DEFAULT_UPSTREAM), {
      mode: 0o600,
    });
  }
  chmodSync(modelEnv, 0o600);

  const rusticEnv = join(root, "secrets", "rustic.env");
  mkdirSync(join(root, "backup"), { recursive: true });
  if (!existsSync(rusticEnv)) {
    writeFileSync(rusticEnv, `# geng: rustic repository password. Lose this and the snapshots are gone.\nRUSTIC_PASSWORD=${randomBytes(18).toString("base64url")}\n`, {
      mode: 0o600,
    });
  }
  chmodSync(rusticEnv, 0o600);

  // Deliberately absent: identity.md, a file under open-loops/, waiting.json.
  // If any of these exist, the first waking is not a birth.
}
