import { randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { makePaths, requiredDirs } from "./paths.ts";

// Everything in this file is `--env-file` into the container, so nothing secret goes here.
// It holds only tokens whose damage is bounded: a search token that can search, a chat id.
const SECRETS_TEMPLATE = `# geng: things the container is allowed to see.
# Injected with \`docker run --env-file\` — never mounted, never in data/, never in backups.
# The model key does NOT belong here: it goes in secrets/model.env, which the container
# never reads (pi posts to the daemon, which adds the key). Nothing here is a credential
# to anything outside: it is what the container is allowed to see.
`;

// Not injected anywhere: the daemon reads it and answers /model/key with it, so the
// container can use the key without being able to read it.
const MODEL_KEY_TEMPLATE = `# geng: the provider key for this instance's model.
# The container never sees this file: pi posts to the daemon, which adds the key.
OPENCODE_API_KEY=
# Where the provider lives. The proxy forwards here; pi is pointed at localhost instead.
GENG_MODEL_UPSTREAM=https://opencode.ai/inference/go/v1
`;

export function initInstance(root: string, instance: string): void {
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

  if (!existsSync(p.secrets)) {
    mkdirSync(dirname(p.secrets), { recursive: true });
    writeFileSync(p.secrets, SECRETS_TEMPLATE, { mode: 0o600 });
  }
  chmodSync(p.secrets, 0o600);

  const modelEnv = join(root, "secrets", "model.env");
  if (!existsSync(modelEnv)) writeFileSync(modelEnv, MODEL_KEY_TEMPLATE, { mode: 0o600 });
  chmodSync(modelEnv, 0o600);

  const rusticEnv = join(root, "secrets", "rustic.env");
  mkdirSync(join(root, "backup"), { recursive: true });
  if (!existsSync(rusticEnv)) {
    writeFileSync(rusticEnv, `# geng: rustic repository password. Lose this and the snapshots are gone.\nRUSTIC_PASSWORD=${randomBytes(18).toString("base64url")}\n`, {
      mode: 0o600,
    });
  }
  chmodSync(rusticEnv, 0o600);

  // Deliberately absent: identity.md, open-loops.json, waiting.json.
  // If any of these exist, the first waking is not a birth.
}
