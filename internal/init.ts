import { randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { makePaths } from "./paths.ts";

const SECRETS_TEMPLATE = `# geng: credentials for this instance.
# Injected with \`docker run --env-file\` — never mounted, never in data/, never in backups.
# Pick the variable your pi provider reads, e.g.:
#   OPENAI_API_KEY=...
#   ANTHROPIC_API_KEY=...
#   DEEPSEEK_API_KEY=...
`;

export function initInstance(root: string, instance: string): void {
  const p = makePaths(root, instance);
  for (const d of [
    p.data,
    p.sessionDir,
    p.palimpsest,
    p.journal,
    p.workspace,
    p.usage,
    p.meta,
    p.inbox,
    p.inboxSeen,
    p.inboxLow,
    p.outbox,
    p.piDir,
    p.openLoops,
    p.people,
  ]) {
    mkdirSync(d, { recursive: true });
  }

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
