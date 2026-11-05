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
import { createWriteStream } from "node:fs";
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
 * GET a path over the socket and stream the body into a file. Bytes do not survive a
 * JSON round trip, and the tool that fetches a file has to end with the file on disk
 * anyway, so it is written as it arrives rather than held in memory.
 */
export function getToFile(
  socketPath: string,
  path: string,
  dest: string,
): Promise<{ status: number; bytes: number }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, method: "GET" }, (res) => {
      if (res.statusCode !== 200) {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => {
          body += c;
        });
        res.on("end", () => reject(new Error(`取不到：${body.slice(0, 300)}`)));
        return;
      }
      const out = createWriteStream(dest);
      // A body that stops halfway — the daemon restarted, the file was pruned while it
      // was being read — arrives as an event on the response, and `pipe` forwards neither
      // errors nor a premature close: without these two handlers the tool dies with an
      // uncaught exception and leaves a half-written file that looks whole. The file that
      // lands in /work is then sent out as if it were the document it is not.
      const cut = (why: string) => (err?: Error) => {
        out.destroy();
        reject(new Error(`${why}：${err?.message ?? "连接断了"}`));
      };
      res.on("error", cut(`取到一半就断了（${dest}）`));
      res.on("aborted", cut(`取到一半就断了（${dest}）`));
      res.pipe(out);
      out.on("finish", () => resolve({ status: 200, bytes: out.bytesWritten }));
      out.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}
