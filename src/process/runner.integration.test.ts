import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import { spawnOwnedMachineProcess, terminateProcessTree } from "./runner.js";

// Native lifetime boundary with controlled peers; not DocWen/Gateway acceptance.
const peer = `#!/usr/bin/python3
import json, os, sys, time
mode = os.environ['DOCWEN_OWNER_TEST_MODE']
helper = os.fork()
if helper == 0:
    null = os.open('/dev/null', os.O_RDWR)
    for fd in (0,1,2): os.dup2(null, fd)
    os.close(null)
    while True: time.sleep(10)
if mode == 'epipe': os.close(0)
print(json.dumps({'root':os.getpid(),'guard':os.getppid(),'helper':helper}),flush=True)
if mode == 'normal':
    sys.stdin.buffer.read()
    os._exit(0)
while True: time.sleep(10)
`;
async function live(pid: number): Promise<boolean> {
  try {
    const s = await readFile(`/proc/${pid}/stat`, "utf8");
    return !["Z", "X", "x"].includes(s.slice(s.lastIndexOf(")") + 2).split(" ")[0]!);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
function bounded<T>(promise: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("native owner fixture timed out")), 4000);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}
it.skipIf(process.platform !== "linux").each(["normal", "epipe", "wrapper-crash", "guardian-crash"])(
  "owns real processes through %s and never signals an unrelated sentinel",
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), "docwen-owned-process-"));
    const script = join(root, "peer.py");
    await writeFile(script, peer, { mode: 0o700 });
    const sentinel = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
    const owned = spawnOwnedMachineProcess(script, {
      cwd: root,
      env: { ...process.env, DOCWEN_OWNER_TEST_MODE: mode },
      shell: false,
      windowsHide: true,
    });
    owned.child.on("error", () => {});
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
      owned.child.once("close", (code, signal) => resolve({ code, signal })),
    );
    try {
      const meta = await bounded(
        new Promise<{ root: number; guard: number; helper: number }>((resolve, reject) => {
          let text = "";
          owned.child.stdout.on("data", (b: Buffer) => {
            text += b.toString();
            if (text.includes("\n")) {
              try {
                resolve(JSON.parse(text.split("\n")[0]!));
              } catch (error) {
                reject(error);
              }
            }
          });
          owned.child.once("error", reject);
        }),
      );
      if (mode === "normal") owned.child.stdin.end();
      if (mode === "epipe") {
        const broken = new Promise<string | undefined>((resolve) =>
          owned.child.stdin.once("error", (error: NodeJS.ErrnoException) => resolve(error.code)),
        );
        owned.child.stdin.write(Buffer.alloc(1024 * 1024));
        expect(await bounded(broken)).toBe("EPIPE");
      }
      if (mode === "wrapper-crash") owned.child.kill("SIGKILL");
      if (mode === "guardian-crash") process.kill(meta.guard, "SIGKILL");
      if (mode === "normal" || mode.endsWith("crash")) await bounded(closed);
      if (mode.endsWith("crash"))
        await expect(terminateProcessTree(owned.child, owned.ownership)).rejects.toMatchObject({
          reason: "linux_owner_unconfirmed",
        });
      else await terminateProcessTree(owned.child, owned.ownership);
      const result = await bounded(closed);
      if (mode === "normal") expect(result.code).toBe(0);
      for (let i = 0; i < 100 && ((await live(meta.root)) || (await live(meta.helper))); i++) await delay(10);
      expect(await live(meta.root)).toBe(false);
      expect(await live(meta.helper)).toBe(false);
      expect(await live(sentinel.pid!)).toBe(true);
      // Reusing the completed ownership object cannot acquire numeric signal authority.
      await terminateProcessTree(owned.child, owned.ownership).catch(() => {});
      expect(await live(sentinel.pid!)).toBe(true);
    } finally {
      await terminateProcessTree(owned.child, owned.ownership).catch(() => {});
      // This is the still-owned direct wrapper, never a remembered numeric group.
      if (owned.child.exitCode === null && owned.child.signalCode === null) owned.child.kill("SIGKILL");
      await bounded(closed);
      sentinel.kill("SIGKILL");
      await rm(root, { recursive: true, force: true });
    }
  },
  10000,
);
