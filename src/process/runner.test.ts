import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

import { beforeEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import {
  captureProcessTreeOwnership,
  type ProcessTreeTerminationError,
  terminateProcessTree,
} from "./runner.js";

class FakeChild extends EventEmitter {
  readonly pid = 43_210;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  readonly kill = vi.fn(() => {
    this.killed = true;
    return true;
  });
}

function mockPosixGroupGone() {
  return vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
    if (signal === 0) {
      throw Object.assign(new Error("gone"), { code: "ESRCH" });
    }
    return true;
  });
}

function mockTaskkillSuccess(): void {
  spawnMock.mockImplementation(() => {
    const killer = new EventEmitter() as EventEmitter & {
      exitCode: number | null;
      signalCode: NodeJS.Signals | null;
      kill: () => boolean;
    };
    killer.exitCode = null;
    killer.signalCode = null;
    killer.kill = vi.fn(() => true);
    queueMicrotask(() => {
      killer.exitCode = 0;
      killer.emit("close", 0);
    });
    return killer;
  });
}

describe("process-tree termination", () => {
  beforeEach(() => spawnMock.mockReset());

  it("uses the platform tree primitive for a live owned child", async () => {
    const child = new FakeChild();
    const processKill = process.platform === "win32" ? undefined : mockPosixGroupGone();
    if (process.platform === "win32") mockTaskkillSuccess();

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
      expect(child.kill).not.toHaveBeenCalled();
    } finally {
      processKill?.mockRestore();
    }
  });

  it("does not mistake a sent signal for confirmed process-tree exit", async () => {
    const child = new FakeChild();
    child.killed = true;
    const processKill = process.platform === "win32" ? undefined : mockPosixGroupGone();
    if (process.platform === "win32") mockTaskkillSuccess();

    try {
      await terminateProcessTree(child as unknown as ChildProcess);
      if (process.platform === "win32") expect(spawnMock).toHaveBeenCalledTimes(1);
      else expect(processKill).toHaveBeenCalledWith(-43_210, "SIGKILL");
    } finally {
      processKill?.mockRestore();
    }
  });

  it("does nothing after an exited child when no captured ownership remains", async () => {
    const child = new FakeChild();
    child.exitCode = 0;
    await terminateProcessTree(child as unknown as ChildProcess);
    expect(spawnMock).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it(
    "retains captured ownership after the direct child exits where the platform can do so safely",
    async () => {
      const child = new FakeChild();
      const ownership = captureProcessTreeOwnership(
        child as unknown as ChildProcess,
        process.platform !== "win32",
      )!;
      child.exitCode = 0;

      if (process.platform === "win32") {
        await expect(
          terminateProcessTree(child as unknown as ChildProcess, ownership),
        ).rejects.toMatchObject<Partial<ProcessTreeTerminationError>>({
          reason: "windows_root_exited",
        });
        expect(spawnMock).not.toHaveBeenCalled();
        return;
      }

      const processKill = mockPosixGroupGone();
      try {
        await terminateProcessTree(child as unknown as ChildProcess, ownership);
        expect(processKill).toHaveBeenCalledWith(-43_210, "SIGKILL");
      } finally {
        processKill.mockRestore();
      }
    },
  );
});
