import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROBE } from "../internal/doctor.ts";

/**
 * The probe has to name the host's own gateway, and it is one shell line inside a
 * JavaScript string: `\$3` in the source is already `$3` by the time the shell sees it,
 * and a bare `$3` inside double quotes is an empty positional parameter — awk then
 * prints the whole route line and the curl that follows can only fail. The check that
 * exists to prove the host's docker is unreachable would say "unreachable" on a host
 * where it is reachable, forever, without ever failing.
 */
test("the docker probe asks the address awk printed, not the whole route line", () => {
  const line = PROBE.find((part) => part.includes("DOCKER_REACHABLE"));
  assert.ok(line !== undefined, "the probe still has the docker check");
  const bin = mkdtempSync(join(tmpdir(), "probe-bin-"));
  writeFileSync(join(bin, "ip"), '#!/bin/sh\necho "default via 172.17.0.1 dev eth0"\n');
  writeFileSync(
    join(bin, "curl"),
    // Records what it was asked for; only the exact URL counts as reachable.
    '#!/bin/sh\nfor a in "$@"; do case "$a" in http://*) [ "$a" = "http://172.17.0.1:2375/version" ] && exit 0;; esac; done\nexit 1\n',
  );
  for (const f of ["ip", "curl"]) chmodSync(join(bin, f), 0o755);
  const out = execFileSync("sh", ["-c", line as string], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
  });
  assert.match(out, /DOCKER_REACHABLE/, `probe said: ${out.trim()}`);
});
