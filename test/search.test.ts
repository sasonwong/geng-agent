import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { readSearchEnv, startSearchServer } from "../internal/search.ts";

// systemd loads secrets/search.env with EnvironmentFile=, so by the time any request
// arrives `process.env` holds the copy from startup. If the environment won, a rotated
// token never took effect and the old one kept being accepted — a stale credential, not
// just a stale quota.
const FROZEN = { GENG_SEARCH_TOKEN: "old", GENG_SEARCH_DAILY: "111" };
const FILE = "GENG_SEARCH_TOKEN=new\nDEEPSEEK_API_KEY=sk-test\nGENG_SEARCH_BIND=127.0.0.1:0\nGENG_SEARCH_DAILY=222\n";

function fixture(): { root: string; restore: () => void } {
  const root = mkdtempSync(join(tmpdir(), "geng-search-"));
  mkdirSync(join(root, "secrets"), { recursive: true });
  writeFileSync(join(root, "secrets", "search.env"), FILE);
  const saved = Object.fromEntries(Object.keys(FROZEN).map((k) => [k, process.env[k]]));
  Object.assign(process.env, FROZEN);
  return {
    root,
    restore: () => {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}

test("the file beats the environment systemd froze at startup", () => {
  const f = fixture();
  try {
    const env = readSearchEnv(f.root);
    assert.equal(env?.token, "new");
    assert.equal(env?.dailyLimit, 222);
  } finally {
    f.restore();
  }
});

test("a token rotated in the file is the one the endpoint accepts", async () => {
  const f = fixture();
  let server: Awaited<ReturnType<typeof startSearchServer>> | null = null;
  try {
    const env = readSearchEnv(f.root);
    assert.ok(env);
    server = await startSearchServer({ root: f.root, env, log: () => {} });
    const port = (server.address() as AddressInfo).port;
    // an unknown path: 401 means the token was rejected, 404 means it got past the check
    const post = async (token: string): Promise<number> => {
      const res = await fetch(`http://127.0.0.1:${port}/nope`, {
        method: "POST",
        headers: { "x-geng-token": token },
      });
      return res.status;
    };
    assert.equal(await post("old"), 401);
    assert.equal(await post("new"), 404);
  } finally {
    server?.close();
    f.restore();
  }
});
