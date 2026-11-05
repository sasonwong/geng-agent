import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { runWaking } from "../internal/rpc.ts";
import type { Command } from "../internal/command.ts";

// A real child that speaks the RPC framing over stdin/stdout. `runWaking` owns the
// process, so the only way to prove what its *result* says is to drive a real one.
// String.raw keeps the "\n" literals intact inside the -e source.
function childCode(settle: boolean): string {
  const afterPrompt = settle
    ? String.raw`w({ type: "tool_execution_start", toolName: "read", args: { path: "a" } });
       w({ type: "tool_execution_start", toolName: "bash", args: { cmd: "sleep" } });
       w({ type: "tool_execution_end" });
       w({ type: "agent_settled" });`
    : String.raw`w({ type: "tool_execution_start", toolName: "bash", args: { cmd: "sleep 999" } });`;
  return String.raw`
    let buf = "";
    const w = (o) => process.stdout.write(JSON.stringify(o) + "\n");
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => {
      buf += c;
      for (;;) {
        const i = buf.indexOf("\n");
        if (i === -1) return;
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let rec; try { rec = JSON.parse(line); } catch { continue; }
        if (rec.type === "prompt") {
          w({ type: "response", id: rec.id, data: { disposition: "started" } });
          ${afterPrompt}
        } else if (rec.type === "get_last_assistant_text") {
          w({ type: "response", id: rec.id, data: { text: "" } });
        } else if (rec.type === "get_session_stats") {
          w({ type: "response", id: rec.id, data: {} });
        } else if (rec.type === "abort") {
          process.exit(0);
        }
      }
    });
  `;
}

function command(code: string): Command {
  return { cmd: process.execPath, args: ["-e", code], env: process.env, cwd: tmpdir() };
}

test("两个并行 start 只来一个 end，仍有一个 open call 没被抹掉", async () => {
  const r = await runWaking({
    command: command(childCode(true)),
    instance: "probe",
    timeoutMs: 30_000,
    prompt: "hi",
    repeatThreshold: 3,
  });
  assert.equal(r.settled, true);
  assert.equal(r.startFailed, false);
  assert.equal(r.timedOut, false);
  // 旧代码只有一个槽位：第二次 start 覆盖第一次，一个 end 又把它清空，于是
  // cut note 会在还有动作在跑时说「什么都没在跑」。
  assert.notEqual(r.openCall, null, "一个 end 不能把另一个还在跑的调用记录清掉");
  assert.equal(r.openCall?.name, "bash", "留下的是 shift 之后仍开着的那个调用");
});

test("被硬超时杀掉的一轮确实启动过，不能算 start-failed", async () => {
  const r = await runWaking({
    command: command(childCode(false)),
    instance: "probe",
    // 留足时间让子进程先答完 prompt；超时是靠 timer 触发，不是靠抢在启动之前。
    timeoutMs: 2_000,
    prompt: "hi",
    repeatThreshold: 3,
  });
  assert.equal(r.timedOut, true);
  assert.equal(r.settled, false);
  // 旧代码 close 里 !settled 就置 startFailed，把超时误标成「没起来」：
  // 只为超时写的 cut.json 恰恰因此永远不写，升级阶梯也走错一级。
  assert.equal(r.startFailed, false, "超时杀掉的这一轮也启动了，不能算 start-failed");
});
