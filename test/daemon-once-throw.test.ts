import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { socketPath } from "../internal/book.ts";
import { makePaths } from "../internal/paths.ts";
import { defaultPolicy } from "../internal/policy.ts";
import { writeJson } from "../internal/fs.ts";

const REPO = fileURLToPath(new URL("..", import.meta.url));

/**
 * A one-off round that throws before the end of the loop body must not keep its caller's
 * process alive. The book listener is opened early and closed only on the way out of the
 * loop; `geng-dev once` exits through `process.exit`, so the one case that showed it was a
 * caller holding the promise — the process stayed up with nothing left to do.
 *
 * Run in a child, because "the process ends" is the property under test and it cannot be
 * observed from inside the process that owns the listener.
 */
test("a once-round that throws leaves no listener holding the process open", () => {
  const root = mkdtempSync(join(tmpdir(), "geng-once-throw-"));
  try {
    const p = makePaths(root, "alice");
    writeJson(p.policy, defaultPolicy());
    // no deploy/SYSTEM.md: the round throws after the book endpoint is already listening
    const entry = join(root, "run-once.mjs");
    writeFileSync(
      entry,
      `import { existsSync } from "node:fs";\n` +
        `import { runDaemon } from ${JSON.stringify(join(REPO, "internal", "daemon.ts"))};\n` +
        `try {\n  await runDaemon({ root: ${JSON.stringify(root)}, instance: "alice", once: true, log: () => {} });\n` +
        `  console.log("round returned");\n} catch (err) {\n` +
        // reported from the child because the parent cannot see whether the endpoint was up
        // at the moment of the throw: without it this test passes trivially if the throw
        // ever moves before `startBookServer`, unref or no unref.
        `  console.log("round threw: " + err.message + " sock=" + existsSync(${JSON.stringify(socketPath(p))}));\n}\n`,
    );
    const child = spawnSync(process.execPath, [entry], {
      cwd: REPO,
      encoding: "utf8",
      timeout: 30_000,
    });
    // A timeout shows up as `error` (ETIMEDOUT) while `status` stays 0 and `signal` stays
    // null, so timing out has to be asserted on `error` or it reads as a clean exit.
    assert.equal(
      (child.error as NodeJS.ErrnoException | undefined)?.code,
      undefined,
      `孩子没自己退出，是被超时杀掉的：${child.stdout}${child.stderr}`,
    );
    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, /round threw/, "这一轮应该是在 book 端点起来之后抛的");
    // and the throw has to happen *after* the endpoint is listening, or nothing above this
    // line proves anything: with no listener there is nothing to hold the process open
    assert.match(child.stdout, /sock=true/, `抛点在 book 端点起来之前，这条测试是空转的：${child.stdout}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
