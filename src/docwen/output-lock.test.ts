import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireOutputLock, type OutputLock } from "./output-lock.js";

const roots: string[] = [];
const locks: OutputLock[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
  }
  for (const lock of locks.splice(0)) await lock.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function target(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "docwen-lock-"));
  roots.push(root);
  return path.join(root, "output");
}

function childLock(destination: string): ChildProcess {
  // Node's built-in TypeScript erasure executes the actual self-contained module.
  const moduleUrl = new URL("./output-lock.ts", import.meta.url).href;
  const code = `import { acquireOutputLock } from ${JSON.stringify(moduleUrl)};
    try {
      await acquireOutputLock(process.argv[1]);
      process.send({ state: "held" });
    } catch (error) {
      process.send({ state: "failed", code: error.code });
      process.disconnect();
    }`;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", code, destination], {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    windowsHide: true,
  });
  children.push(child);
  return child;
}

describe("OS-owned output lock", () => {
  it("rejects another writer and reacquires after explicit close without filesystem residue", async () => {
    const destination = await target();
    const first = await acquireOutputLock(destination);
    locks.push(first);
    first.assertHeld();
    await expect(acquireOutputLock(destination)).rejects.toMatchObject({ code: "EADDRINUSE" });
    await first.close();
    expect(() => first.assertHeld()).toThrow();
    const next = await acquireOutputLock(destination);
    locks.push(next);
    expect(await readdir(path.dirname(destination))).toEqual([]);
  });

  it("releases after an owning process is killed without reading or deleting a PID file", async () => {
    const destination = await target();
    const child = childLock(destination);
    expect((await once(child, "message"))[0]).toEqual({ state: "held" });
    await expect(acquireOutputLock(destination)).rejects.toMatchObject({ code: "EADDRINUSE" });
    child.kill("SIGKILL");
    await once(child, "exit");
    locks.push(await acquireOutputLock(destination));
    expect(await readdir(path.dirname(destination))).toEqual([]);
  });

  it("arbitrates two actual processes", async () => {
    const destination = await target();
    const first = childLock(destination);
    expect((await once(first, "message"))[0]).toEqual({ state: "held" });
    const second = childLock(destination);
    expect((await once(second, "message"))[0]).toEqual({ state: "failed", code: "EADDRINUSE" });
  });

  it("locks normalized aliases of the same destination", async () => {
    const destination = await target();
    locks.push(await acquireOutputLock(destination));
    const alias = path.join(
      path.dirname(destination),
      "unused",
      "..",
      process.platform === "win32" ? "OUTPUT" : "output",
    );
    await expect(acquireOutputLock(alias)).rejects.toMatchObject({ code: "EADDRINUSE" });
  });

  it("leaves acquisition failures retryable", async () => {
    const destination = await target();
    const nested = path.join(path.dirname(destination), "missing", "output");
    await expect(acquireOutputLock(nested)).rejects.toMatchObject({ code: "ENOENT" });
    await mkdir(path.dirname(nested));
    locks.push(await acquireOutputLock(nested));
  });
});
