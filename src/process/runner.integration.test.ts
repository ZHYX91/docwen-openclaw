import { spawn } from "node:child_process";
import { once } from "node:events";
import type * as FsPromises from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";

import { expect, it, vi } from "vitest";

const deniedReads = vi.hoisted(() => new Set<string>());
const observedDenials = vi.hoisted(() => new Set<string>());
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof FsPromises>();
  return {
    ...original,
    readFile: (...args: Parameters<typeof original.readFile>) => {
      const file = String(args[0]);
      if (deniedReads.has(file)) {
        observedDenials.add(file);
        return Promise.reject(Object.assign(new Error("Injected procfs read denial"), { code: "EACCES" }));
      }
      return original.readFile(...args);
    },
  };
});

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

it
  .skipIf(process.platform !== "linux")
  .each([
    "normal",
    "unrelated-stat-denied",
    "member-stat-denied",
    "member-both-denied",
    "unrelated-both-denied",
  ] as const)(
  "checks a delayed-reap owned group without mistaking procfs uncertainty for live membership: %s",
  async (scenario) => {
    deniedReads.clear();
    observedDenials.clear();
    const supervisor = spawn("python3", ["-c", supervisorScript], {
      stdio: ["pipe", "pipe", "inherit"],
      windowsHide: true,
    });
    const lines = createInterface({ input: supervisor.stdout });
    const iterator = lines[Symbol.asyncIterator]();
    let ownedGroupId: number | undefined;
    let helperPid: number | undefined;

    try {
      const first = await Promise.race([
        iterator.next(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Timed out waiting for delayed-reaper fixture.")), 3_000),
        ),
      ]);
      expect(first.done).toBe(false);
      const ready = JSON.parse(first.value!) as { rootPid: number; helperPid: number; pgid: number };
      ownedGroupId = ready.pgid;
      helperPid = ready.helperPid;
      expect(ready.rootPid).toBe(ready.pgid);
      const before = await linuxProcessState(ready.helperPid);
      expect(before).not.toBe("Z");
      expect(before).not.toBe("X");

      // The supervisor is a real unrelated sentinel in the test runner's
      // process group. Its child established its own group with setsid().
      const deniedPid = scenario.startsWith("unrelated") ? supervisor.pid! : ready.helperPid;
      if (scenario !== "normal") deniedReads.add(`/proc/${deniedPid}/stat`);
      if (scenario.endsWith("both-denied")) deniedReads.add(`/proc/${deniedPid}/status`);

      const startedAt = performance.now();
      const cleanup = terminateProcessTree(supervisor, {
        kind: "posix-process-group",
        processGroupId: ready.pgid,
      });
      if (scenario.endsWith("both-denied")) {
        await expect(cleanup).rejects.toMatchObject({ reason: "process_group_state_unconfirmed" });
      } else {
        await cleanup;
        expect(performance.now() - startedAt).toBeLessThan(1_500);
      }
      expect(supervisor.exitCode).toBeNull();
      expect(process.kill(supervisor.pid!, 0)).toBe(true);
      for (const denied of deniedReads) expect(observedDenials.has(denied)).toBe(true);

      // The subreaper deliberately withholds waitpid here. The helper is dead
      // but remains present in /proc as a zombie, which must not be treated as
      // a live process-tree leak.
      expect(await linuxProcessState(ready.helperPid)).toBe("Z");

      deniedReads.clear();
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
      // Once the group is gone, procfs restrictions cannot turn ESRCH into
      // a cleanup failure. A still-live unrelated PID remains untouched.
      deniedReads.add(`/proc/${process.pid}/stat`);
      deniedReads.add(`/proc/${process.pid}/status`);
      await terminateProcessTree(supervisor, { kind: "posix-process-group", processGroupId: ready.pgid });
    } finally {
      deniedReads.clear();
      lines.close();
      if (ownedGroupId !== undefined) {
        try {
          process.kill(-ownedGroupId, "SIGKILL");
        } catch {
          // The exact process group belongs to this fixture and may already be gone.
        }
      }
      if (helperPid !== undefined) {
        try {
          process.kill(helperPid, "SIGKILL");
        } catch {
          // The exact helper PID belongs to this fixture and may already be reaped.
        }
      }
      if (supervisor.exitCode === null && supervisor.signalCode === null) supervisor.kill("SIGKILL");
    }
  },
  8_000,
);

async function linuxProcessState(pid: number): Promise<string> {
  // Independent observation must not use the injected product read failures.
  const actual = await vi.importActual<typeof FsPromises>("node:fs/promises");
  const stat = await actual.readFile(`/proc/${pid}/stat`, "utf8");
  const commandEnd = stat.lastIndexOf(") ");
  if (commandEnd < 0) throw new Error("Unexpected /proc stat format.");
  return stat.slice(commandEnd + 2).split(" ")[0]!;
}
