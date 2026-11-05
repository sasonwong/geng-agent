import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (name: string): string => readFileSync(join(ROOT, name), "utf8");

test("the lockfile and the docs agree with the Node version the gateway requires", () => {
  const pkg = JSON.parse(read("package.json")) as { engines: { node: string } };
  const lock = JSON.parse(read("package-lock.json")) as {
    packages: { "": { engines: { node: string } } };
  };
  // `npm ci` reads the lock, and the lock is what a deploy checks. Leaving the old
  // range there while package.json moved to 22.21.0 told a reader two different
  // minimum versions for the same install.
  assert.equal(lock.packages[""].engines.node, pkg.engines.node);

  const wanted = pkg.engines.node.match(/(\d+\.\d+\.\d+)/)?.[1];
  assert.ok(wanted, "engines.node 要写成一个具体的最低版本");
  for (const doc of ["AGENTS.md", "docs/install.md"]) {
    assert.ok(read(doc).includes(wanted), `${doc} 没有写出 ${wanted}`);
  }
});
