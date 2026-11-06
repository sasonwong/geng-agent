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

/**
 * The same request, except a dead socket comes back as a reply the model can read.
 *
 * `postJson` rejects on ENOENT / ECONNREFUSED / a timeout on purpose — the caller decides
 * what that means. Every tool caller means the same thing, though: a host that is briefly
 * down is a sentence, not an exception that ends the waking through a tool result nobody
 * can act on. One place for that decision keeps the tools from drifting apart again.
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
  timeoutMs = 120_000,
): Promise<{ status: number; bytes: number }> {
  return new Promise((resolve, reject) => {
    // A partial download must never sit at the destination looking like the whole file,
    // and a file that was already there must not be deleted by a failed replacement.
    const part = `${dest}.geng-part-${process.pid}`;
    let settled = false;
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      try {
        rmSync(part, { force: true });
      } catch {
        // the cleanup is best effort; the name says what it is
      }
      reject(err);
    };
    const req = request(
      { socketPath, path, method: "GET", signal: AbortSignal.timeout(timeoutMs) },
      (res) => {
        if (res.statusCode !== 200) {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (c: string) => {
            body += c;
          });
          res.on("end", () => fail(new Error(`取不到：${body.slice(0, 300)}`)));
          return;
        }
        rmSync(part, { force: true });
        const out = createWriteStream(part);
        let bytes = 0;
        res.on("data", (c: Buffer) => {
          bytes += c.length;
        });
        res.pipe(out);
        res.on("error", fail);
        out.on("error", fail);
        out.on("finish", () => {
          if (settled) return;
          settled = true;
          try {
            renameSync(part, dest);
            resolve({ status: 200, bytes });
          } catch (err) {
            settled = false;
            fail(err as Error);
          }
        });
      },
    );
    req.on("error", fail);
    req.end();
  });
}
