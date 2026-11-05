import { createSign } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { Paths } from "./paths.ts";
import { readEnvFile } from "./secret.ts";

/**
 * A GitHub App installation token, minted on the host and handed to `git` over the same
 * socket as everything else.
 *
 * The alternative — a personal access token in the instance's env file — is a credential
 * that never expires and that the agent can read out of its own environment. An app
 * installation token is a credential the agent has never seen written down: it is minted
 * when git asks, lives about an hour, and is cached only in the daemon's memory.
 */
export interface GhApp {
  appId: string;
  installationId: string;
  keyPem: string;
}

/** Configured means all three: two ids in the env file and the private key on disk. */
export function readGhApp(p: Paths): { app: GhApp | null; missing: string[] } {
  const env = readEnvFile(p.secrets);
  const keyPath = p.ghAppKey;
  const missing: string[] = [];
  const appId = env.GENG_GH_APP_ID ?? "";
  const installationId = env.GENG_GH_INSTALLATION_ID ?? "";
  if (appId === "") missing.push("GENG_GH_APP_ID");
  if (installationId === "") missing.push("GENG_GH_INSTALLATION_ID");
  const keyPem = existsSync(keyPath) ? readFileSync(keyPath, "utf8") : "";
  if (keyPem === "") missing.push(keyPath);
  if (missing.length > 0) return { app: null, missing };
  return { app: { appId, installationId, keyPem }, missing };
}

function b64(input: string): string {
  return Buffer.from(input).toString("base64url");
}

/**
 * The JWT GitHub wants as proof of being the app: RS256, issued a minute in the past
 * (their clocks and ours are not the same clock) and valid for nine minutes, which is
 * the documented maximum.
 */
export function makeJwt(app: { appId: string; keyPem: string }, nowMs: number): string {
  const header = b64(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64(
    JSON.stringify({
      iat: Math.floor(nowMs / 1000) - 60,
      // GitHub rejects anything longer than ten minutes; nine leaves room for the network
      exp: Math.floor(nowMs / 1000) + 540,
      iss: app.appId,
    }),
  );
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  const signature = signer.sign(app.keyPem).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

const SECURITY = 300_000;
/** GitHub is normally instant; a black-holed connection must not leave `git` waiting. */
export const TOKEN_TIMEOUT_MS = 15_000;

interface Cached {
  token: string;
  expiresAt: number;
}

const cache = new Map<string, Cached>();

/**
 * Exchange the app's identity for an installation token, reusing the last one while it has
 * more than five minutes left. One round may run dozens of git commands, and GitHub's
 * token endpoint is rate limited too.
 */
export async function installationToken(
  app: GhApp,
  nowMs: number,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = TOKEN_TIMEOUT_MS,
): Promise<Cached> {
  const key = `${app.appId}/${app.installationId}`;
  const hit = cache.get(key);
  if (hit && hit.expiresAt - SECURITY > nowMs) return hit;
  const response = await fetchImpl(
    `https://api.github.com/app/installations/${app.installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${makeJwt(app, nowMs)}`,
        accept: "application/vnd.github+json",
        "user-agent": "geng-agent",
      },
      // The signal covers the whole exchange, body included: without it a connected but
      // silent endpoint holds `/gh/token` open, and every `git` command in the round
      // hangs on a credential helper that never prints a line.
      signal: AbortSignal.timeout(timeoutMs),
    },
  );
  const body = (await response.json().catch(() => ({}))) as { token?: string; expires_at?: string; message?: string };
  if (!response.ok || typeof body.token !== "string" || body.token === "") {
    throw new Error(`换 installation token 失败：${response.status} ${body.message ?? "没有说明"}`);
  }
  // An unparseable expires_at used to become NaN. `NaN - SECURITY > now` is false on
  // every check, so a token was minted again for every single git command instead of
  // being reused for the hour GitHub gave it.
  const parsed = typeof body.expires_at === "string" ? Date.parse(body.expires_at) : Number.NaN;
  const fresh = {
    token: body.token,
    expiresAt: Number.isFinite(parsed) ? parsed : nowMs + 3_600_000,
  };
  cache.set(key, fresh);
  return fresh;
}

/** Only for tests: one process, one cache, and a test is a second process. */
export function forgetCachedTokens(): void {
  cache.clear();
}
