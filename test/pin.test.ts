import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { keeperName, pinImage } from "../internal/docker.ts";
import { imageMissing } from "../internal/env.ts";

const ID = `sha256:${"a".repeat(64)}`;
const OTHER = `sha256:${"b".repeat(64)}`;

/**
 * A `docker` that records its argv and answers from the case body. PATH is the seam
 * `dockerRun` already uses; the real daemon is not needed to test a decision.
 */
async function withFake<T>(body: string, fn: (calls: () => string[]) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "geng-pin-"));
  const oldPath = process.env.PATH;
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "docker"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${join(root, "calls")}"\n${body}\n`);
  chmodSync(join(bin, "docker"), 0o755);
  const calls = (): string[] => {
    try {
      return readFileSync(join(root, "calls"), "utf8").trim().split("\n").filter(Boolean);
    } catch {
      return [];
    }
  };
  try {
    process.env.PATH = `${bin}${delimiter}${oldPath ?? ""}`;
    return await fn(calls);
  } finally {
    process.env.PATH = oldPath;
    rmSync(root, { recursive: true, force: true });
  }
}

/** `docker inspect` answers with one line; everything else succeeds silently. */
function inspectSays(line: string): string {
  return `case "$1" in\n  inspect) printf '%s\\n' "${line}"; exit 0 ;;\n  *) exit 0 ;;\nesac`;
}

test("two image names that sanitise the same still get different keepers", () => {
  // `registry:5000/foo` and `registry_5000/foo` are different images and would share a
  // container name without the hash — one of the two would silently stop being pinned
  assert.notEqual(keeperName("registry:5000/foo:1"), keeperName("registry_5000/foo:1"));
  assert.match(keeperName("geng-agent:latest"), /^geng-image-keeper-[A-Za-z0-9_.-]+$/);
});

test("a keeper already running the current image is left alone", async () => {
  await withFake(inspectSays(`true ${ID}`), async (calls) => {
    assert.equal(await pinImage("geng-agent:latest", ID), "kept");
    const seen = calls();
    assert.equal(seen.length, 1, "一次 inspect 就够，不碰容器");
    assert.match(seen[0]!, /^inspect --type container /);
  });
});

for (const [label, line] of [
  ["stopped", `false ${ID}`],
  ["holding an older id", `true ${OTHER}`],
] as const) {
  test(`a keeper that is ${label} is recreated running`, async () => {
    await withFake(inspectSays(line), async (calls) => {
      assert.equal(await pinImage("geng-agent:latest", ID), "pinned");
      const seen = calls();
      assert.match(seen[1]!, /^rm -f geng-image-keeper-/);
      const run = seen[2]!;
      assert.match(run, /^run -d --name geng-image-keeper-/);
      // stopped containers are pruned before images, so "running" is the whole point
      assert.match(run, /--restart unless-stopped/);
      assert.match(run, /--network none/);
    });
  });
}

test("only an answered 'no such image' counts as missing", async () => {
  // `docker image inspect` exits non-zero for both "no image" and "cannot connect". A
  // daemon that starts before dockerd must not rebuild for the second one.
  await withFake(`case "$1" in\n  info) exit 1 ;;\n  *) exit 0 ;;\nesac`, async (calls) => {
    assert.equal(await imageMissing("geng-agent:latest"), false);
    assert.deepEqual(calls(), ["info"], "连 image inspect 都不该问");
  });
  await withFake(`case "$1" in\n  info) exit 0 ;;\n  image) exit 1 ;;\n  *) exit 0 ;;\nesac`, async () => {
    assert.equal(await imageMissing("geng-agent:latest"), true);
  });
  await withFake(`case "$1" in\n  info) exit 0 ;;\n  image) exit 0 ;;\n  *) exit 0 ;;\nesac`, async () => {
    assert.equal(await imageMissing("geng-agent:latest"), false);
  });
});
