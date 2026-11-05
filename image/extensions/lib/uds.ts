/**
 * POST JSON to a unix socket, from inside the container.
 *
 * `fetch` cannot speak to a socket, so this is the 30 lines it takes to say the same
 * thing. Nothing here imports pi: the file is a client, not a tool, and keeping it free
 * of those imports is what lets a test exercise it without the image.
 *
 * The socket is mounted read-only into the container, so a tool cannot replace it, and
 * a host-side process is the only thing on the other end.
 */
import { createWriteStream, renameSync, rmSync } from "node:fs";
import { request } from "node:http";

export interface UdsReply {
  status: number;
  body: string;
}

export function postJson(
  socketPath: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
  timeoutMs = 70_000,
): Promise<UdsReply> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body ?? {});
    const req = request(
      {
        socketPath,
        path,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
          ...headers,
        },
        signal: AbortSignal.timeout(timeoutMs),
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => {
          text += c;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
      },
    );
    // ENOENT and ECONNREFUSED both mean "nothing is listening", and the message a person
    // reads must say that instead of a syscall name.
    req.on("error", (err: NodeJS.ErrnoException) => {
      const why =
        err.code === "ENOENT" || err.code === "ECONNREFUSED"
          ? `没有东西在听 ${socketPath}：宿主上的服务没起来。`
          : err.message;
      reject(new Error(why));
    });
    req.write(payload);
    req.end();
  });
}

/**
 * The same request, except a dead socket comes back as a reply the model can read.
 *
 * `postJson` rejects on ENOENT / ECONNREFUSED / timeout on purpose — the caller decides
 * what that means. Every tool caller means the same thing, though: a host that is briefly
 * down is a sentence ("宿主上的服务没起来"), not an exception that ends the waking with
 * no words at all. `say-mute` used to say so in its own try/catch while `book`, `recall`
 * and `websearch` threw; one place for that decision keeps them from drifting again.
 */
export async function postJsonOrError(
  socketPath: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
  timeoutMs = 70_000,
): Promise<UdsReply> {
  try {
    return await postJson(socketPath, path, body, headers, timeoutMs);
  } catch (err) {
    return { status: 0, body: JSON.stringify({ error: (err as Error).message }) };
  }
}

/**
 * GET a path over the socket and stream the body into a file. Bytes do not survive a
 * JSON round trip, and the tool that fetches a file has to end with the file on disk
 * anyway, so it is written as it arrives rather than held in memory.
 */
export function getToFile(
  socketPath: string,
  path: string,
  dest: string,
  timeoutMs = 70_000,
): Promise<{ status: number; bytes: number }> {
  return new Promise((resolve, reject) => {
    // postJson has a deadline; this one did not. A host that stopped answering left the
    // download tool hanging until the daemon's wall-clock timeout killed the whole round.
    // Stream into a sibling part file first: a body that stops halfway used to leave a
    // half-written file at `dest` that looked whole and was later sent out as the document.
    // And a failed re-download must never delete the good file already at `dest`.
    const part = `${dest}.geng-part-${process.pid}`;
    let settled = false;
    const once = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };
    // Only the part file is ever removed. `force` makes a missing part a no-op; the
    // try/catch is for the moment the fd is still open and Windows refuses the unlink —
    // the `close` listener below retries once the handle is released.
    const cleanup = (): void => {
      try {
        rmSync(part, { force: true });
      } catch {
        // 等 close 再清；实在不行，下一轮下载前的 cleanup() 会兜底
      }
    };
    let out: ReturnType<typeof createWriteStream> | null = null;
    // Every way the transfer can break goes through here, and none of them touches `dest`.
    const fail = (err: Error): void => {
      if (settled) return;
      if (out !== null) {
        // 句柄释放后再清一次：fd 还开着时 Windows 的 rmSync 会撞上 EBUSY
        out.once("close", cleanup);
        out.destroy();
      }
      cleanup();
      once(() => reject(err));
    };
    // A part left by a process killed mid-write must not be appended to.
    cleanup();
    const req = request(
      { socketPath, path, method: "GET", signal: AbortSignal.timeout(timeoutMs) },
      (res) => {
        if (res.statusCode !== 200) {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (c: string) => {
            body += c;
          });
          res.on("end", () => once(() => reject(new Error(`取不到：${body.slice(0, 300)}`))));
          res.on("error", fail);
          res.on("aborted", () => fail(new Error("响应中断")));
          return;
        }
        const stream = createWriteStream(part);
        out = stream;
        res.on("error", fail);
        res.on("aborted", () => fail(new Error("响应中断")));
        out.on("error", fail);
        out.on("finish", () => {
          // 已经失败就别把一个半截的 part 提升成 dest。
          if (settled) return;
          try {
            renameSync(part, dest);
          } catch (err) {
            fail(err as Error);
            return;
          }
          once(() => resolve({ status: 200, bytes: stream.bytesWritten }));
        });
        res.pipe(stream);
      },
    );
    req.on("error", fail);
    req.end();
  });
}
