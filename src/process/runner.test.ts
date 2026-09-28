import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

import { beforeEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import { captureProcessTreeOwnership, spawnOwnedMachineProcess, terminateProcessTree } from "./runner.js";

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

  it("launches the Machine process behind the platform-owned boundary", () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);
    const binaryPath =
      process.platform === "win32" ? "C:\\DocWen\\DocWenCLI.exe" : "/opt/docwen/DocWenCLI";
    const launched = spawnOwnedMachineProcess(binaryPath, {
      cwd: process.platform === "win32" ? "C:\\DocWen" : "/opt/docwen",
      env: { DOCWEN_DATA_DIR: "profile" },
      shell: false,
      windowsHide: true,
    });

    expect(launched.child).toBe(child);
    if (process.platform === "win32") {
      expect(launched.ownership).toEqual({ kind: "windows-job-wrapper" });
      expect(spawnMock).toHaveBeenCalledWith(
        expect.stringMatching(/[\\/]native[\\/]windows-x64\.exe$/iu),
        [],
        expect.objectContaining({
          detached: false,
          env: expect.objectContaining({
            DOCWEN_DATA_DIR: "profile",
            OPENCLAW_DOCWEN_JOB_TARGET: binaryPath,
          }),
          stdio: ["pipe", "pipe", "pipe"],
        }),
      );
    } else {
      expect(launched.ownership).toEqual({ kind: "posix-process-group", processGroupId: 43_210 });
      expect(spawnMock).toHaveBeenCalledWith(
        binaryPath,
        ["serve", "--stdio"],
        expect.objectContaining({ detached: true, stdio: ["pipe", "pipe", "pipe"] }),
      );
    }
  });

  it("uses the platform tree primitive for a live generic owned child", async () => {
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

  it("does not mistake a sent signal for confirmed generic process-tree exit", async () => {
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

  it("kills the Windows job controller even after a previous signal was sent", async () => {
    const child = new FakeChild();
    child.killed = true;
    await terminateProcessTree(child as unknown as ChildProcess, { kind: "windows-job-wrapper" });
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("does nothing after an exited child when no captured ownership remains", async () => {
    const child = new FakeChild();
    child.exitCode = 0;
    await terminateProcessTree(child as unknown as ChildProcess);
    expect(spawnMock).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("retains captured generic ownership after safe direct-child exit", async () => {
    const child = new FakeChild();
    const ownership = captureProcessTreeOwnership(
      child as unknown as ChildProcess,
      process.platform !== "win32",
    )!;
    child.exitCode = 0;

    if (process.platform === "win32") {
      await expect(
        terminateProcessTree(child as unknown as ChildProcess, ownership),
      ).rejects.toMatchObject({
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
  });
});
