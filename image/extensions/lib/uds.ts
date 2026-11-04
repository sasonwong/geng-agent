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
