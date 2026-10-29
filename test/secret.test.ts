import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  envProblem,
  mailWiringProblem,
  newToken,
  readEnvFile,
  searchPairProblem,
  writeEnvValue,
} from "../internal/secret.ts";

const dir = (): string => mkdtempSync(join(tmpdir(), "geng-secret-"));

test("an env file keeps its comments and only moves the line it was asked to move", () => {
  const d = dir();
  const file = join(d, "alice.env");
  writeFileSync(file, "# 这是注释\nOPENCODE_API_KEY=old\n# 中间一行\nOTHER=1\n");

  writeEnvValue(file, "OPENCODE_API_KEY", "new");
  writeEnvValue(file, "GENG_SEARCH_TOKEN", "tok");

  const text = readFileSync(file, "utf8");
  assert.match(text, /^# 这是注释$/m);
  assert.match(text, /^# 中间一行$/m);
  assert.equal(readEnvFile(file).OPENCODE_API_KEY, "new");
  assert.equal(readEnvFile(file).OTHER, "1");
  assert.equal(readEnvFile(file).GENG_SEARCH_TOKEN, "tok");
  // a secret file that is group/world readable is a secret in name only
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test("reading an env file ignores comments, blank lines and lines with no equals", () => {
  const d = dir();
  const file = join(d, "x.env");
  writeFileSync(file, "# a\n\nA=1\nB = 2 \nnot a kv line\n");
  assert.deepEqual(readEnvFile(file), { A: "1", B: "2" });
  assert.deepEqual(readEnvFile(join(d, "missing.env")), {});
});

test("a token that has to exist in two files is the same string or it is a bug", () => {
  assert.equal(searchPairProblem({}, {}), null, "nothing configured is not a problem");
  assert.equal(
    searchPairProblem({ GENG_SEARCH_URL: "http://x:1", GENG_SEARCH_TOKEN: "t" }, { GENG_SEARCH_TOKEN: "t" }),
    null,
  );
  // the container-side copy without the endpoint does nothing at all
  assert.match(searchPairProblem({ GENG_SEARCH_TOKEN: "t" }, {}) ?? "", /却没有/);
  // the endpoint without a token is a 401 that looks like a dead network
  assert.match(searchPairProblem({ GENG_SEARCH_URL: "http://x:1" }, {}) ?? "", /却没有/);
  // both sides present but different: the quiet one
  assert.match(
    searchPairProblem({ GENG_SEARCH_URL: "http://x:1", GENG_SEARCH_TOKEN: "a" }, { GENG_SEARCH_TOKEN: "b" }) ?? "",
    /不一致/,
  );
});

test("a mailbox with only half of its wiring is reported, because neither half complains", () => {
  const mail = { "a@example.com": { instance: "alice", allow: ["you@example.org"] } };
  const env = { token: "t", bind: { host: "127.0.0.1", port: 8788 } };
  assert.equal(mailWiringProblem("alice", mail, env), null);
  assert.equal(mailWiringProblem("bob", null, null), null, "not using mail is fine");
  assert.match(mailWiringProblem("alice", mail, null) ?? "", /没有 token/);
  assert.match(mailWiringProblem("bob", mail, env) ?? "", /没有地址指向/);
});

test("an instance with no model key is named as the reason its first waking will fail", () => {
  assert.match(envProblem({}) ?? "", /API_KEY/);
  assert.match(envProblem({ GENG_SEARCH_URL: "http://x" }) ?? "", /API_KEY/);
  assert.equal(envProblem({ OPENCODE_API_KEY: "k" }), null);
  assert.equal(envProblem({ DEEPSEEK_API_KEY: "k" }), null, "any provider's name is fine");
});

test("generated tokens are long enough to not be guessable and differ each time", () => {
  const a = newToken();
  const b = newToken();
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.notEqual(a, b);
});
