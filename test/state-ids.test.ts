import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { makePaths } from "../internal/paths.ts";
import { allocate } from "../internal/ids.ts";

const idsUrl = new URL("../internal/ids.ts", import.meta.url).href;

function idle(): Int32Array {
  return new Int32Array(new SharedArrayBuffer(4));
}

/** Spin in place (1ms a turn) until a cross-process condition holds; Atomics.wait is
 * allowed on the main thread in Node, so this needs no timers and no event loop. */
function waitFor(pred: () => boolean, iterations = 10_000): void {
  const a = idle();
  for (let i = 0; i < iterations && !pred(); i++) Atomics.wait(a, 0, 0, 1);
}

function runChild(paths: ReturnType<typeof makePaths>, go: string, ready: string): Promise<string> {
  const code = String.raw`
    import { allocate } from ${JSON.stringify(idsUrl)};
    import { writeFileSync, existsSync } from "node:fs";
    const paths = ${JSON.stringify(paths)};
    const go = ${JSON.stringify(go)};
    const ready = ${JSON.stringify(ready)};
    writeFileSync(ready, "ok");
    const a = new Int32Array(new SharedArrayBuffer(4));
    for (let i = 0; i < 10000 && !existsSync(go); i++) Atomics.wait(a, 0, 0, 1);
    process.stdout.write(allocate(paths, "file").id);
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => (out += c));
    child.stderr.on("data", (c: string) => (err += c));
    child.on("error", reject);
    child.on("close", (status) =>
      status === 0 ? resolve(out.trim()) : reject(new Error(`子进程退出 ${status}：${err}`)),
    );
  });
}

test("几个进程同时分配文件 id，不会拿到同一个号", async () => {
  const root = mkdtempSync(join(tmpdir(), "geng-ids-"));
  const p = makePaths(root, "alice");
  const go = join(root, "go");
  const N = 6;
  const readies = Array.from({ length: N }, (_, i) => join(root, `ready-${i}`));
  // 所有子进程先各自跑到锁前，再一起放行，最大化 read-modify-write 的重叠。
  const children = readies.map((ready) => runChild(p, go, ready));
  waitFor(() => readies.every((r) => existsSync(r)));
  writeFileSync(go, "go");
  const ids = await Promise.all(children);
  // 没有锁时它们都读到空 ids.json、都算出 F1；锁把整段临界区串行化，号必须各不相同。
  assert.equal(new Set(ids).size, N, `id 重复了：${ids.join(",")}`);
  for (const id of ids) assert.match(id, /^F\d+$/);
});

test("崩溃留下的旧锁会被回收，且用完一定清掉", () => {
  const root = mkdtempSync(join(tmpdir(), "geng-ids-"));
  const p = makePaths(root, "alice");
  const lock = `${p.ids}.lock`;
  mkdirSync(dirname(lock), { recursive: true });
  // 模拟上一个进程崩在临界区里：锁还在，但 mtime 已经超过 10s。
  writeFileSync(lock, "");
  const old = new Date(Date.now() - 20_000);
  utimesSync(lock, old, old);
  assert.equal(allocate(p, "file").id, "F1");
  // 旧代码根本不认这个锁文件，既不会回收也不会清：这一条会在旧实现上红。
  assert.equal(existsSync(lock), false, "回收并 finally 清掉的锁不该留在盘上");
});
