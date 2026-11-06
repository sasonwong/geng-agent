import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { defaultSearchSocket, readSearchEnv, searchQuota, startSearchServer } from "../internal/search.ts";
import { postJson } from "../image/extensions/lib/uds.ts";

// systemd loads secrets/search.env with EnvironmentFile=, so by the time any request
// arrives `process.env` holds the copy from startup. If the environment won, a raised
// quota never took effect: the endpoint kept enforcing the number it started with.
const FROZEN = { GENG_SEARCH_DAILY: "111" };

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

// split so the repo's secret scanner does not read the fixture as a credential
const PROVIDER_LINE = ["DEEPSEEK_API_KEY", "sk-not-a-real-key"].join("=");

function envText(sock: string, extra = "", keyLine = PROVIDER_LINE): string {
  const lines = [keyLine, `GENG_SEARCH_SOCKET=${sock}`];
  if (extra !== "") lines.push(extra);
  return lines.join("\n") + "\n";
}

test("the default socket follows the user manager's RuntimeDirectory", () => {
  // RuntimeDirectory=geng in a *user* unit creates $XDG_RUNTIME_DIR/geng, not
  // /run/geng. A hard-coded /run/geng made the service listen where it could not
  // create a directory, and the daemon looked for a different socket entirely.
  const saved = process.env.XDG_RUNTIME_DIR;
  try {
    const runtime = join(tmpdir(), "run-user-1000");
    process.env.XDG_RUNTIME_DIR = runtime;
    assert.equal(defaultSearchSocket(), join(runtime, "geng", "search.sock"));
    delete process.env.XDG_RUNTIME_DIR;
    assert.equal(defaultSearchSocket(), join("/run", "geng", "search.sock"));
  } finally {
    if (saved === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = saved;
  }
});

test("a foreground search run makes the RuntimeDirectory itself", async () => {
  // RuntimeDirectory=geng is a systemd favour. `node cmd/geng/index.ts search` from a
  // shell has no manager to create $XDG_RUNTIME_DIR/geng, and listen() does not create
  // parent directories — the documented foreground command used to die with ENOENT.
  const root = mkdtempSync(join(tmpdir(), "geng-search-dir-"));
  mkdirSync(join(root, "secrets"), { recursive: true });
  const nested = join(root, "run-user-1000", "geng", "search.sock");
  writeFileSync(join(root, "secrets", "search.env"), envText(nested));
  const env = readSearchEnv(root);
  assert.ok(env);
  assert.equal(existsSync(dirname(nested)), false, "the point of the test: nobody made it");
  let server: Awaited<ReturnType<typeof startSearchServer>> | null = null;
  try {
    try {
      server = await startSearchServer({ root, env, log: () => {} });
    } catch (err) {
      // Windows cannot bind a unix socket at a filesystem path; the directory is
      // still created first, which is the assertion below.
      if (process.platform !== "win32") throw err;
      assert.match((err as Error).message, /EACCES|ENOENT|permission|access/i);
    }
  } finally {
    server?.close();
  }
  assert.equal(existsSync(dirname(nested)), true, "the parent must exist before listen()");
});

test("the file beats the environment systemd froze at startup", () => {
  const f = fixture();
  try {
    const env = readSearchEnv(f.root);
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
  // A hand-added note after the number stays in the value: systemd's
  // `EnvironmentFile=` does not strip inline comments, so trimming alone leaves
  // `300   # …`, which is not a finite number and used to be dropped in favour of
  // the default — the operator's 300 silently becoming 200.
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
  try {
    writeFileSync(join(f.root, "secrets", "search.env"), envText(f.sock, "GENG_SEARCH_DAILY="));
    assert.equal(searchQuota(f.root)?.limit, 111);
    assert.equal(searchQuota(f.root)?.left, 111);
    delete process.env.GENG_SEARCH_DAILY;
    assert.equal(searchQuota(f.root)?.limit, 200);
  } finally {
    f.restore();
  }
});

test("no socket, no quota: the page must not promise what the container cannot spend", () => {
  // The tool is mounted only when the socket file exists, so a search.env whose service
  // is not running has to read as "no search" — otherwise the page says "今天还能搜 200 次"
  // over a container that has no web_search at all.
  const f = fixture();
  try {
    assert.notEqual(searchQuota(f.root), null);
    // a socket path nothing created: the endpoint is configured, the service is not up
    writeFileSync(join(f.root, "secrets", "search.env"), envText(join(f.root, "gone.sock")));
    assert.equal(searchQuota(f.root), null);
    // and without the provider key there is nothing to spend either
    writeFileSync(join(f.root, "secrets", "search.env"), envText(f.sock, "", "DEEPSEEK_API_KEY="));
    assert.equal(searchQuota(f.root), null);
  } finally {
    f.restore();
  }
});

test("reaching the socket is the whole authorization", async () => {
  const f = fixture();
  let server: Awaited<ReturnType<typeof startSearchServer>> | null = null;
  try {
    const env = readSearchEnv(f.root);
    assert.ok(env);
    server = await startSearchServer({ root: f.root, env, log: () => {} });
    // No header, no token: the socket is the boundary. A token in the container's env was
    // a second copy of a secret that protected nothing the socket did not already.
    assert.equal((await postJson(f.sock, "/nope", {})).status, 404);
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
  const day = new Date().toISOString().slice(0, 10);
  try {
    mkdirSync(join(f.root, "data", "_ops", "usage"), { recursive: true });
    writeFileSync(join(f.root, "secrets", "search.env"), envText(f.sock, "GENG_SEARCH_DAILY="));
    delete process.env.GENG_SEARCH_DAILY;
    writeFileSync(usage, JSON.stringify({ day, count: 0, limit: 0 }));
    assert.equal(searchQuota(f.root)?.left, 0); // before: the old zero wins
    const env = readSearchEnv(f.root);
    assert.ok(env);
    server = await startSearchServer({ root: f.root, env, log: () => {} });
    assert.deepEqual(searchQuota(f.root), { limit: 200, left: 200 });
    writeFileSync(usage, JSON.stringify({ day, count: 0, limit: null }));
    assert.equal(searchQuota(f.root)?.limit, 200); // NaN written as null = unset
  } finally {
    server?.close();
    f.restore();
  }
});

test("a call that fails upstream costs nothing: only an answer is charged", async () => {
  const f = fixture();
  let server: Awaited<ReturnType<typeof startSearchServer>> | null = null;
  const usage = join(f.root, "data", "_ops", "usage", "search.json");
  const env = readSearchEnv(f.root);
  assert.ok(env);
  try {
    server = await startSearchServer({ root: f.root, env, log: () => {} });
    const sent: Record<string, unknown>[] = [];
    const realFetch = globalThis.fetch;
    // a stand-in upstream that refuses: the quota must not move
    globalThis.fetch = (async () => {
      sent.push({});
      return { ok: false, status: 401, text: async () => '{"error":"bad key"}' } as unknown as Response;
    }) as typeof fetch;
    try {
      const reply = await postJson(f.sock, "/search", { query: "x" });
      assert.equal(reply.status, 502);
      assert.equal(JSON.parse(reply.body).remaining, env.dailyLimit, "失败的调用不扣次数");
      assert.equal(sent.length, 1, "请求确实发出去了");
      const spent = JSON.parse(readFileSync(usage, "utf8")) as { count?: number };
      assert.equal(spent.count ?? 0, 0);
      // and one that did come back is charged exactly once
      globalThis.fetch = (async () =>
        ({ ok: true, status: 200, text: async () => '{"results":[]}' }) as unknown as Response) as typeof fetch;
      const good = await postJson(f.sock, "/search", { query: "y" });
      assert.equal(good.status, 200);
      assert.equal(JSON.parse(good.body).remaining, env.dailyLimit - 1);
      assert.equal((JSON.parse(readFileSync(usage, "utf8")) as { count?: number }).count, 1);
    } finally {
      globalThis.fetch = realFetch;
    }
  } finally {
    server?.close();
    f.restore();
  }
});
