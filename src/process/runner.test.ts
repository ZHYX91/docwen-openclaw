import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { terminateProcessTree } from "./runner.js";
afterEach(() => vi.useRealTimers());
class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly kill = vi.fn(() => true);
}
const asChild = (child: FakeChild) => child as unknown as ChildProcess;
it("never derives signal authority from an unowned numeric PID", async () => {
  const child = new FakeChild();
  const kill = vi.spyOn(process, "kill");
  try {
    await terminateProcessTree(asChild(child));
    expect(kill).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
  } finally {
    kill.mockRestore();
  }
});
it("waits for the owned completion even after the controlling child exits", async () => {
  const child = new FakeChild();
  child.exitCode = 0;
  let complete!: () => void;
  const completion = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const stop = vi.fn();
  let settled = false;
  const pending = terminateProcessTree(asChild(child), { kind: "linux-supervisor", completion, stop }).then(
    () => {
      settled = true;
    },
  );
  await Promise.resolve();
  expect(stop).toHaveBeenCalledTimes(1);
  expect(settled).toBe(false);
  complete();
  await pending;
  expect(settled).toBe(true);
  expect(child.kill).not.toHaveBeenCalled();
});
it("reports rejected native cleanup instead of substituting a PID signal", async () => {
  const child = new FakeChild();
  await expect(
    terminateProcessTree(asChild(child), {
      kind: "linux-supervisor",
      completion: Promise.reject(new Error("unconfirmed")),
      stop: vi.fn(),
    }),
  ).rejects.toMatchObject({ reason: "linux_owner_unconfirmed" });
  expect(child.kill).not.toHaveBeenCalled();
});
it("bounds an owner that never confirms completion", async () => {
  vi.useFakeTimers();
  const child = new FakeChild();
  const check = expect(
    terminateProcessTree(asChild(child), {
      kind: "linux-supervisor",
      completion: new Promise(() => {}),
      stop: vi.fn(),
    }),
  ).rejects.toMatchObject({ reason: "linux_owner_unconfirmed" });
  await vi.advanceTimersByTimeAsync(2500);
  await check;
  expect(child.kill).not.toHaveBeenCalled();
});
it("kills the live Windows job controller and leaves an exited one alone", async () => {
  const child = new FakeChild();
  await terminateProcessTree(asChild(child), { kind: "windows-job-wrapper" });
  expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  child.kill.mockClear();
  child.exitCode = 0;
  await terminateProcessTree(asChild(child), { kind: "windows-job-wrapper" });
  expect(child.kill).not.toHaveBeenCalled();
});
it("does not claim Windows cleanup when the controller cannot be killed", async () => {
  const child = new FakeChild();
  child.kill.mockReturnValue(false);
  await expect(terminateProcessTree(asChild(child), { kind: "windows-job-wrapper" })).rejects.toMatchObject({
    reason: "windows_wrapper_kill_failed",
  });
});
