import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";

import { expect, it } from "vitest";

import { terminateProcessTree } from "./runner.js";

const supervisorScript = String.raw`
import ctypes, json, os, sys, time

libc = ctypes.CDLL(None)
if libc.prctl(36, 1, 0, 0, 0) != 0:
    raise OSError(ctypes.get_errno(), "PR_SET_CHILD_SUBREAPER failed")

read_fd, write_fd = os.pipe()
root = os.fork()
if root == 0:
    os.close(read_fd)
    os.setsid()
    helper = os.fork()
    if helper == 0:
        os.close(write_fd)
        while True:
            time.sleep(60)
    os.write(write_fd, f"{os.getpid()} {helper}\n".encode())
    os.close(write_fd)
    os._exit(0)

os.close(write_fd)
payload = os.read(read_fd, 128).decode().strip()
os.close(read_fd)
root_pid, helper_pid = [int(value) for value in payload.split()]
os.waitpid(root, 0)
print(json.dumps({"rootPid": root_pid, "helperPid": helper_pid, "pgid": root_pid}), flush=True)

command = sys.stdin.readline().strip()
if command != "reap":
    raise RuntimeError("unexpected supervisor command")
reaped, _ = os.waitpid(helper_pid, 0)
print(json.dumps({"reapedPid": reaped}), flush=True)
`;

it.skipIf(process.platform !== "linux")(
  "settles an owned group when only a delayed-reap zombie remains, then reaps the fixture child",
  async () => {
    const supervisor = spawn("python3", ["-c", supervisorScript], {
      stdio: ["pipe", "pipe", "inherit"],
      windowsHide: true,
    });
    const lines = createInterface({ input: supervisor.stdout });
    const iterator = lines[Symbol.asyncIterator]();

    try {
      const first = await Promise.race([
        iterator.next(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Timed out waiting for delayed-reaper fixture.")), 3_000),
        ),
      ]);
      expect(first.done).toBe(false);
      const ready = JSON.parse(first.value!) as { rootPid: number; helperPid: number; pgid: number };
      expect(ready.rootPid).toBe(ready.pgid);
      const before = await linuxProcessState(ready.helperPid);
      expect(before).not.toBe("Z");
      expect(before).not.toBe("X");

      const startedAt = performance.now();
      await terminateProcessTree(supervisor, {
        kind: "posix-process-group",
        processGroupId: ready.pgid,
      });
      expect(performance.now() - startedAt).toBeLessThan(1_500);

      // The subreaper deliberately withholds waitpid here. The helper is dead
      // but remains present in /proc as a zombie, which must not be treated as
      // a live process-tree leak.
      expect(await linuxProcessState(ready.helperPid)).toBe("Z");

      supervisor.stdin.end("reap\n");
      const second = await Promise.race([
        iterator.next(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Timed out waiting for controlled reap.")), 3_000),
        ),
      ]);
      expect(second.done).toBe(false);
      expect(JSON.parse(second.value!)).toEqual({ reapedPid: ready.helperPid });
      const [code] = (await once(supervisor, "close")) as [number | null];
      expect(code).toBe(0);
      await expect(readFile(`/proc/${ready.helperPid}/stat`, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      lines.close();
      if (supervisor.exitCode === null && supervisor.signalCode === null) supervisor.kill("SIGKILL");
    }
  },
  8_000,
);

async function linuxProcessState(pid: number): Promise<string> {
  const stat = await readFile(`/proc/${pid}/stat`, "utf8");
  const commandEnd = stat.lastIndexOf(") ");
  if (commandEnd < 0) throw new Error("Unexpected /proc stat format.");
  return stat.slice(commandEnd + 2).split(" ")[0]!;
}
