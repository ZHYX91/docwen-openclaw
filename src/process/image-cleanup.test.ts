import { unlinkSync, rmdirSync } from "node:fs";
import type * as FileSystem from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, basename, join } from "node:path";
import { tmpdir } from "node:os";
import type { Duplex } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { linuxOwnerErrorDetails, spawnLinuxOwnedMachine } from "./linux-owner.js";
import { terminateProcessTree } from "./runner.js";
import { runDocWenMachineQuery } from "../docwen/machine-client.js";

vi.mock("node:fs", async (original) => {
  const fs = await original<typeof FileSystem>();
  return { ...fs, unlinkSync: vi.fn(fs.unlinkSync), rmdirSync: vi.fn(fs.rmdirSync) };
});
const roots = new Set<string>();
afterEach(async () => {
  vi.mocked(unlinkSync).mockReset();
  vi.mocked(rmdirSync).mockReset();
  const fs = await vi.importActual<typeof FileSystem>("node:fs");
  vi.mocked(unlinkSync).mockImplementation(fs.unlinkSync);
  vi.mocked(rmdirSync).mockImplementation(fs.rmdirSync);
  for (const root of roots) await rm(root, { recursive: true, force: true });
  roots.clear();
});
async function inject(phase: "image_unlink" | "directory_remove"): Promise<void> {
  const fs = await vi.importActual<typeof FileSystem>("node:fs");
  const reject = (path: FileSystem.PathLike, fallback: typeof unlinkSync, isDirectory: boolean) => {
    const root = isDirectory ? String(path) : dirname(String(path));
    if (basename(root).startsWith("docwen-owner-")) {
      roots.add(root);
      throw Object.assign(new Error("private path must not escape"), { code: "EACCES" });
    }
    fallback(path);
  };
  if (phase === "image_unlink")
    vi.mocked(unlinkSync).mockImplementation((path) => reject(path, fs.unlinkSync, false));
  else vi.mocked(rmdirSync).mockImplementation((path) => reject(path, fs.rmdirSync, true));
}

describe.skipIf(process.platform !== "linux")("native image cleanup failures", () => {
  it.each(["image_unlink", "directory_remove"] as const)(
    "records %s before delivering a pre-READY control failure",
    async (phase) => {
      await inject(phase);
      const { child, ownership } = spawnLinuxOwnedMachine(process.execPath, {
        cwd: tmpdir(),
        env: process.env,
        shell: false,
        windowsHide: true,
      });
      const control = child.stdio[3] as Duplex;
      const write = vi.spyOn(control, "write");
      const startup = new Promise<Error>((resolve) => child.once("error", resolve));
      const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
      // No event-loop turn has consumed READY. Keep real close after assertions.
      child.kill("SIGSTOP");
      control.destroy(Object.assign(new Error("private early control failure"), { code: "EIO" }));
      try {
        const primary = await startup;
        const details = { cleanupObject: "owner_image", cleanupPhase: phase, cleanupSystemCode: "EACCES" };
        expect(linuxOwnerErrorDetails(primary)).toMatchObject(details);
        expect(child.listenerCount("error")).toBe(0);
        expect(child.exitCode).toBeNull();
        await expect(terminateProcessTree(child, ownership)).rejects.toMatchObject({
          reason: "linux_owner_unconfirmed",
          diagnostics: details,
        });
        expect(write).not.toHaveBeenCalled();
        expect(JSON.stringify(details)).not.toContain("private");
      } finally {
        child.kill("SIGCONT");
        await closed;
      }
    },
  );
  it.each(["image_unlink", "directory_remove"] as const)(
    "keeps DONE separate from %s failure",
    async (phase) => {
      await inject(phase);
      const { child, ownership } = spawnLinuxOwnedMachine(process.execPath, {
        cwd: tmpdir(),
        env: process.env,
        shell: false,
        windowsHide: true,
      });
      const write = vi.spyOn(child.stdio[3] as Duplex, "write");
      const error = new Promise<Error>((resolve) => child.once("error", resolve));
      const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
      const primary = await error;
      expect(linuxOwnerErrorDetails(primary)).toMatchObject({
        cleanupObject: "owner_image",
        cleanupPhase: phase,
        cleanupSystemCode: "EACCES",
      });
      await expect(terminateProcessTree(child, ownership)).resolves.toBeUndefined();
      await closed;
      expect(write).not.toHaveBeenCalled();
      expect(child.exitCode).toBe(125);
    },
  );
  it.each(["image_unlink", "directory_remove"] as const)(
    "preserves missing-cwd ENOENT plus %s",
    async (phase) => {
      await inject(phase);
      const { child, ownership } = spawnLinuxOwnedMachine(process.execPath, {
        cwd: join(tmpdir(), `missing-owner-cwd-${crypto.randomUUID()}`),
        env: process.env,
        shell: false,
        windowsHide: true,
      });
      const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
      const primary = await new Promise<Error>((resolve) => child.once("error", resolve));
      expect(primary).toMatchObject({ code: "ENOENT" });
      expect(linuxOwnerErrorDetails(primary)).toMatchObject({
        primarySystemCode: "ENOENT",
        cleanupSystemCode: "EACCES",
        cleanupPhase: phase,
      });
      await expect(terminateProcessTree(child, ownership)).resolves.toBeUndefined();
      await closed;
    },
  );
  it("retains image facts when the owner also exits without DONE", async () => {
    await inject("image_unlink");
    const { child, ownership } = spawnLinuxOwnedMachine(process.execPath, {
      cwd: tmpdir(),
      env: process.env,
      shell: false,
      windowsHide: true,
    });
    const control = child.stdio[3] as Duplex;
    // Kill before sending control EOF, while the real START gate is waiting.
    const end = control.end.bind(control);
    vi.spyOn(control, "end").mockImplementation(() => {
      child.kill("SIGKILL");
      return end();
    });
    const startup = new Promise<Error>((resolve) => child.once("error", resolve));
    child.on("error", () => {});
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    await startup;
    await expect(terminateProcessTree(child, ownership)).rejects.toMatchObject({
      reason: "linux_owner_unconfirmed",
      diagnostics: { cleanupObject: "owner_image", cleanupSystemCode: "EACCES" },
    });
    await closed;
  });
  it("returns a safe Machine startup error instead of false process uncertainty", async () => {
    await inject("image_unlink");
    let failure: unknown;
    try {
      await runDocWenMachineQuery({
        binaryPath: process.execPath,
        method: "health/check",
        params: {},
        timeoutMs: 1000,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: "docwen_machine_spawn_failed",
      details: { cleanupObject: "owner_image", cleanupSystemCode: "EACCES" },
    });
    expect(JSON.stringify(failure)).not.toContain("private path");
    expect(JSON.stringify(failure)).not.toContain("docwen-owner-");
  });
  it.each([
    ["image_unlink", "deadline"],
    ["directory_remove", "deadline"],
    ["image_unlink", "control-error"],
    ["directory_remove", "control-error"],
  ] as const)("keeps %s facts after %s without a second child error", async (phase, fault) => {
    await inject(phase);
    const { child, ownership } = spawnLinuxOwnedMachine(process.execPath, {
      cwd: tmpdir(),
      env: process.env,
      shell: false,
      windowsHide: true,
    });
    const control = child.stdio[3] as Duplex;
    const end = control.end.bind(control);
    vi.spyOn(control, "end").mockImplementation(() => {
      // Pause the real owner at START; still close the actual control write end.
      child.kill("SIGSTOP");
      return end();
    });
    const write = vi.spyOn(control, "write");
    const startup = new Promise<Error>((resolve) => child.once("error", resolve));
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    try {
      await startup;
      expect(child.listenerCount("error")).toBe(0);
      if (fault === "control-error")
        control.destroy(Object.assign(new Error("private control failure"), { code: "EIO" }));
      const result = await terminateProcessTree(child, ownership).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(result).toMatchObject({
        reason: "linux_owner_unconfirmed",
        diagnostics: { cleanupObject: "owner_image", cleanupPhase: phase, cleanupSystemCode: "EACCES" },
      });
      expect(write).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toContain("private");
      expect(JSON.stringify(result)).not.toContain("docwen-owner-");
      // Recovery occurs after the recorded failure, not as evidence of timely cleanup.
      child.kill("SIGCONT");
      await closed;
      if (fault === "deadline") await expect(ownership.completion).resolves.toBeUndefined();
      expect(result).toMatchObject({ reason: "linux_owner_unconfirmed" });
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGCONT");
        child.kill("SIGKILL");
      }
      await closed;
    }
  });
});
