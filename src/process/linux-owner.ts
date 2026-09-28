import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";

// Updated together with the reviewed native source, payload and build receipt.
export const LINUX_OWNER_SHA256 = "6cdaabc6cfd844cbda6dcfee284e91b6320417830e1afae4366300a109125c51";
export type LinuxOwner = Readonly<{ kind: "linux-supervisor"; completion: Promise<void>; stop: () => void }>;

export function spawnLinuxOwnedMachine(
  binaryPath: string,
  options: { cwd: string; env: NodeJS.ProcessEnv; shell: false; windowsHide: true },
): { child: ChildProcessWithoutNullStreams; ownership: LinuxOwner } {
  if (process.arch !== "x64") throw new Error("The Linux Machine process owner requires x64.");
  const payload = readFileSync(new URL("../../native/linux-owner-x64", import.meta.url));
  if (
    payload.length > 128 * 1024 ||
    createHash("sha256").update(payload).digest("hex") !== LINUX_OWNER_SHA256
  )
    throw new Error("Linux process owner integrity mismatch.");
  const root = mkdtempSync(join(tmpdir(), "docwen-owner-"));
  const executable = join(root, "owner");
  let imagePresent = false;
  let rootPresent = true;
  function cleanImage(): void {
    if (imagePresent) {
      unlinkSync(executable);
      imagePresent = false;
    }
    if (rootPresent) {
      rmdirSync(root);
      rootPresent = false;
    }
  }
  let child: ChildProcessWithoutNullStreams;
  try {
    const descriptor = openSync(executable, "wx", 0o500);
    imagePresent = true;
    try {
      writeFileSync(descriptor, payload);
    } finally {
      closeSync(descriptor);
    }
    child = spawn(executable, [binaryPath], {
      ...options,
      detached: false,
      stdio: ["pipe", "pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
  } catch (error) {
    try {
      cleanImage();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], "Linux owner preparation and cleanup failed.", {
        cause: cleanup,
      });
    }
    throw error;
  }
  const control = child.stdio[3] as Duplex;
  let resolveCompletion!: () => void;
  let rejectCompletion!: (error: Error) => void;
  const completion = new Promise<void>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  void completion.catch(() => undefined);
  let ready = false,
    done = false,
    stopping = false,
    failed = false;
  let pending = "";
  let startupError = false;
  const stop = (): void => {
    if (stopping || done) return;
    stopping = true;
    if (!control.destroyed && !control.writableEnded) control.end();
  };
  const fail = (message: string, emit = true): void => {
    if (failed || done) return;
    failed = true;
    const error = new Error(message);
    rejectCompletion(error);
    stop();
    if (emit) child.emit("error", error);
  };
  control.on("data", (bytes: Buffer) => {
    if (failed || done) return;
    pending += bytes.toString("ascii");
    if (pending.length > 256) {
      fail("Linux owner status exceeded its limit.");
      return;
    }
    while (pending.includes("\n") && !failed && !done) {
      const end = pending.indexOf("\n");
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      if (line === "DWO1 READY 0" && !ready) {
        ready = true;
        try {
          cleanImage();
        } catch {
          fail("Linux owner executable cleanup failed before Machine start.");
          return;
        }
        if (!stopping) control.write("A");
      } else if (/^DWO1 DONE (?:[0-9]|[1-9][0-9]{1,2})$/u.test(line) && ready) {
        const code = Number(line.slice(10));
        if (code > 255) {
          fail("Linux owner returned an invalid exit result.");
          return;
        }
        done = true;
        resolveCompletion();
      } else if (/^DWO1 ERROR [1-9][0-9]*$/u.test(line) && ready && !startupError) {
        startupError = true;
        stop();
        // A launch error and confirmed teardown are independent outcomes.
        child.emit("error", new Error("Linux Machine owner could not start the configured executable."));
      } else {
        fail("Linux Machine owner cleanup was not confirmed.");
      }
    }
  });
  control.on("error", () => fail("Linux owner control channel failed."));
  child.once("error", () => {
    if (startupError) return;
    try {
      cleanImage();
    } catch {
      fail("Linux owner failed and executable cleanup remained incomplete.", false);
      return;
    }
    if (child.pid === undefined && !ready) {
      done = true;
      resolveCompletion();
    } else fail("Linux owner failed to start or complete.", false);
  });
  child.once("close", () => {
    try {
      cleanImage();
    } catch {
      fail("Linux owner executable cleanup remained incomplete.", false);
    }
    if (!done) fail("Linux owner exited without confirmed cleanup.", false);
    control.destroy();
  });
  return { child, ownership: { kind: "linux-supervisor", completion, stop } };
}
