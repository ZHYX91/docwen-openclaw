import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { createServer } from "node:net";
import * as path from "node:path";

export interface OutputLock {
  assertHeld(): void;
  close(): Promise<void>;
}

/** OS-owned local IPC endpoints disappear on process exit; no PID or stale-file recovery. */
export async function acquireOutputLock(destination: string): Promise<OutputLock> {
  if (process.platform !== "win32" && process.platform !== "linux") {
    throw Object.assign(new Error("Output locking requires Windows or Linux."), { code: "ENOTSUP" });
  }
  const parent = await realpath(path.dirname(destination));
  let canonical = path.join(parent, path.basename(destination));
  if (process.platform === "win32") canonical = canonical.toLowerCase();
  const digest = createHash("sha256").update(canonical).digest("hex");
  const endpoint =
    process.platform === "win32" ? `\\\\.\\pipe\\docwen-output-${digest}` : `\0docwen-output-${digest}`;
  const server = createServer((socket) => socket.destroy());
  let failure: Error | undefined;
  let closed = false;
  server.on("error", (error) => {
    failure = error;
  });
  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error) => {
      server.removeListener("listening", listening);
      reject(error);
    };
    const listening = () => {
      server.removeListener("error", failed);
      resolve();
    };
    server.once("error", failed);
    server.once("listening", listening);
    server.listen({ path: endpoint, exclusive: true });
  });
  return {
    assertHeld() {
      if (failure || closed || !server.listening) {
        throw Object.assign(new Error("The output lock is no longer held."), {
          code: "ELOCKLOST",
          cause: failure,
        });
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
