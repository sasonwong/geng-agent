import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../cmd/geng/index.ts", import.meta.url));

/** The real binary, on a throwaway root: the parse of argv is the thing under test. */
function run(args: string[], stdin = ""): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [CLI, ...args], { timeout: 20_000 }, (err, stdout, stderr) => {
      const code = err === null ? 0 : ((err as { code?: number }).code ?? "?");
      resolve({ code: typeof code === "number" ? code : -1, out: `${stdout}${stderr}` });
    });
    child.stdin?.end(stdin);
  });
}

function root(): string {
  return mkdtempSync(join(tmpdir(), "geng-cli-"));
}

// The subcommand is the first positional, and a fallback that read it as the instance name
// turned a missing argument into a *valid* invocation of a different command: no error, a
// file in secrets/, and nobody looking for it.
test("a subcommand is not an instance name", async () => {
  const r = root();
  const secrets = await run(["secrets", "init", "--root", r]);
  assert.equal(secrets.code, 2, secrets.out);
  assert.match(secrets.out, /用法/);
  assert.equal(existsSync(join(r, "secrets", "init.env")), false, "少了实例名，不该写出一个叫 init 的文件");

  const bots = await run(["bots", "add", "--root", r, "--token-stdin"], "1:not-a-bot\n");
  assert.equal(bots.code, 2, bots.out);
  assert.match(bots.out, /用法/);
  assert.equal(existsSync(join(r, "secrets", "bots.json")), false, "少了实例名，不该建一个叫 add 的 bot");
});

test("the same two commands with a name still work", async () => {
  const r = root();
  const secrets = await run(["secrets", "init", "alice", "--root", r]);
  assert.equal(secrets.code, 0, secrets.out);
  assert.deepEqual(readdirSync(join(r, "secrets")).filter((f) => f.endsWith(".env")), ["mail.env"]);

  const bots = await run(["bots", "add", "alice", "--root", r, "--token-stdin"], "1:not-a-bot\n");
  assert.equal(bots.code, 0, bots.out);
  assert.deepEqual(readdirSync(join(r, "secrets")).filter((f) => f === "bots.json"), ["bots.json"]);
});
