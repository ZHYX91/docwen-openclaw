import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

import { beforeEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import { terminateProcessTree } from "./runner.js";

class FakeChild extends EventEmitter {
  readonly pid = 43_210;
  exitCode: number | null = null;
  killed = false;
  readonly kill = vi.fn(() => {
    this.killed = true;
    return true;
  });
}

describe("process-tree termination", () => {
  beforeEach(() => spawnMock.mockReset());

  it("uses the platform tree primitive before a final child kill", async () => {
    const child = new FakeChild();
    const processKill =
      process.platform === "win32" ? undefined : vi.spyOn(process, "kill").mockImplementation(() => true);
    if (process.platform === "win32") {
      spawnMock.mockImplementation(() => {
        const killer = new EventEmitter();
        queueMicrotask(() => killer.emit("close", 0));
        return killer;
      });
    }

    try {
      await terminateProcessTree(child as unknown as ChildProcess);
      if (process.platform === "win32") {
        expect(spawnMock).toHaveBeenCalledWith(
          "taskkill.exe",
          ["/PID", "43210", "/T", "/F"],
          expect.objectContaining({ shell: false, windowsHide: true, stdio: "ignore" }),
        );
      } else {
        expect(processKill).toHaveBeenCalledWith(-43_210, "SIGKILL");
      }
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    } finally {
      processKill?.mockRestore();
    }
  });

  it("does nothing after the child has already exited", async () => {
    const child = new FakeChild();
    child.exitCode = 0;
    await terminateProcessTree(child as unknown as ChildProcess);
    expect(spawnMock).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
  });
});
