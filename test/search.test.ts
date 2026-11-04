import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSearchEnv, searchQuota, startSearchServer } from "../internal/search.ts";
import { postJson } from "../image/extensions/lib/uds.ts";

// systemd loads secrets/search.env with EnvironmentFile=, so by the time any request
// arrives `process.env` holds the copy from startup. If the environment won, a rotated
// token never took effect and the old one kept being accepted — a stale credential, not
// just a stale quota.
const FROZEN = { GENG_SEARCH_TOKEN: "old", GENG_SEARCH_DAILY: "111" };

function fixture(): { root: string; sock: string; restore: () => void } {
  const root = mkdtempSync(join(tmpdir(), "geng-search-"));
  // The path lives under the tmpdir: a test that binds /run/geng would need root, and a
  // test that skips the bind would not prove the socket is what the predicate looks at.
  const sock = join(root, "search.sock");
  mkdirSync(join(root, "secrets"), { recursive: true });
  writeFileSync(join(root, "secrets", "search.env"), envText(sock, "GENG_SEARCH_DAILY=222"));
  // A plain file where the socket will be: the predicate asks whether a socket exists,
  // not whether something answers on it — that is the connect path's job.
  writeFileSync(sock, "");
  const saved = Object.fromEntries(Object.keys(FROZEN).map((k) => [k, process.env[k]]));
  Object.assign(process.env, FROZEN);
  return {
    root,
    sock,
    restore: () => {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}

function envText(sock: string, extra = ""): string {
  const lines = [
    "GENG_SEARCH_TOKEN=new",
    "DEEPSEEK_API_KEY=sk-test",
    `GENG_SEARCH_SOCKET=${sock}`,
  ];
  if (extra !== "") lines.push(extra);
  return lines.join("\n") + "\n";
}

test("the file beats the environment systemd froze at startup", () => {
  const f = fixture();
  try {
    const env = readSearchEnv(f.root);
    assert.equal(env?.token, "new");
    assert.equal(env?.dailyLimit, 222);
    assert.equal(env?.socket, f.sock);
  } finally {
    f.restore();
  }
});

test("an empty quota line means unset — not a quota of zero", () => {
  // Number("") is 0, so `GENG_SEARCH_DAILY=` used to shut search off silently and for good:
  // every request answered "今天的搜索用完了" and the limit the server enforced was 0 too.
  const f = fixture();
  try {
    writeFileSync(join(f.root, "secrets", "search.env"), envText(f.sock, "GENG_SEARCH_DAILY="));
    assert.equal(readSearchEnv(f.root)?.dailyLimit, 111); // the file carries nothing: the environment does
    delete process.env.GENG_SEARCH_DAILY;
    assert.equal(readSearchEnv(f.root)?.dailyLimit, 200); // and then the code default
    writeFileSync(join(f.root, "secrets", "search.env"), envText(f.sock, "GENG_SEARCH_DAILY=0"));
    assert.equal(readSearchEnv(f.root)?.dailyLimit, 0); // a written zero is still a decision
  } finally {
    f.restore();
  }
});

test("a trailing note on the quota line is the note's problem, not the quota's", () => {
  // docs/install.md writes the line with a note after it; `EnvironmentFile=` keeps the
  // note in the value, so trimming alone leaves `200   # …`, which is not a finite number
  // and used to be dropped in favour of the default — the operator's 300 silently becoming 200.
  const f = fixture();
  try {
    writeFileSync(join(f.root, "secrets", "search.env"), envText(f.sock, "GENG_SEARCH_DAILY=300   # 少搜点"));
    assert.equal(readSearchEnv(f.root)?.dailyLimit, 300);
    writeFileSync(join(f.root, "secrets", "search.env"), envText(f.sock, "GENG_SEARCH_DAILY=  # 300"));
    assert.equal(readSearchEnv(f.root)?.dailyLimit, 111); // comment-only counts as empty, not as 300
  } finally {
    f.restore();
  }
});

test("the quota the agent is shown uses the same reading of an empty line", () => {
  const f = fixture();
  const instance = join(f.root, "instance.env");
  writeFileSync(instance, "GENG_SEARCH_TOKEN=new\n");
  try {
    writeFileSync(join(f.root, "secrets", "search.env"), envText(f.sock, "GENG_SEARCH_DAILY="));
    assert.equal(searchQuota(f.root, instance)?.limit, 111);
    assert.equal(searchQuota(f.root, instance)?.left, 111);
    delete process.env.GENG_SEARCH_DAILY;
    assert.equal(searchQuota(f.root, instance)?.limit, 200);
  } finally {
    f.restore();
  }
});

test("no socket, no quota: the page must not promise what the container cannot spend", () => {
  // The tool is mounted only when the socket file exists, so a search.env whose service
  // is not running has to read as "no search" — otherwise the page says "今天还能搜 200 次"
  // over a container that has no web_search at all.
  const f = fixture();
  const instance = join(f.root, "instance.env");
  writeFileSync(instance, "GENG_SEARCH_TOKEN=new\n");
  try {
    assert.notEqual(searchQuota(f.root, instance), null);
    // a socket path nothing created: the endpoint is configured, the service is not up
    writeFileSync(join(f.root, "secrets", "search.env"), envText(join(f.root, "gone.sock")));
    assert.equal(searchQuota(f.root, instance), null);
    // and an instance without the token gets nothing either
    writeFileSync(join(f.root, "secrets", "search.env"), envText(f.sock));
    writeFileSync(instance, "DEEPSEEK_API_KEY=sk-test\n");
    assert.equal(searchQuota(f.root, instance), null);
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
    // an unknown path: 401 means the token was rejected, 404 means it got past the check
    const status = async (token: string): Promise<number> => {
      const reply = await postJson(f.sock, "/nope", {}, { "x-geng-token": token });
      return reply.status;
    };
    assert.equal(await status("old"), 401);
    assert.equal(await status("new"), 404);
  } finally {
    server?.close();
    f.restore();
  }
});

test("a quota file left at zero by an earlier run is not a permanent verdict", async () => {
  // The bug writes `limit: 0` into usage/search.json on every start. An upgrade must not
  // inherit that verdict: the endpoint rewrites the file from the limit it is actually
  // enforcing, and a `null` (what JSON.stringify(NaN) leaves behind) reads as unset.
  const f = fixture();
  let server: Awaited<ReturnType<typeof startSearchServer>> | null = null;
  const usage = join(f.root, "data", "_ops", "usage", "search.json");
  const instance = join(f.root, "instance.env");
  const day = new Date().toISOString().slice(0, 10);
  try {
    mkdirSync(join(f.root, "data", "_ops", "usage"), { recursive: true });
    writeFileSync(join(f.root, "secrets", "search.env"), envText(f.sock, "GENG_SEARCH_DAILY="));
    delete process.env.GENG_SEARCH_DAILY;
    writeFileSync(instance, "GENG_SEARCH_TOKEN=new\n");
    writeFileSync(usage, JSON.stringify({ day, count: 0, limit: 0 }));
    assert.equal(searchQuota(f.root, instance)?.left, 0); // before: the old zero wins
    const env = readSearchEnv(f.root);
    assert.ok(env);
    server = await startSearchServer({ root: f.root, env, log: () => {} });
    assert.deepEqual(searchQuota(f.root, instance), { limit: 200, left: 200 });
    writeFileSync(usage, JSON.stringify({ day, count: 0, limit: null }));
    assert.equal(searchQuota(f.root, instance)?.limit, 200); // NaN written as null = unset
  } finally {
    server?.close();
    f.restore();
  }
});
