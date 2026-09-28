import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { linuxOwnerErrorDetails, spawnLinuxOwnedMachine, type LinuxOwner } from "./linux-owner.js";

// The native owner has a two-second reap budget; allow delivery of its result.
const TERMINATION_TIMEOUT_MS = 2_500;
const WINDOWS_JOB_TARGET = "OPENCLAW_DOCWEN_JOB_TARGET";
export type ProcessTreeOwnership = Readonly<{ kind: "windows-job-wrapper" }> | LinuxOwner;
export type ProcessTreeTerminationReason = "windows_wrapper_kill_failed" | "linux_owner_unconfirmed";
export class ProcessTreeTerminationError extends Error {
  constructor(
    readonly reason: ProcessTreeTerminationReason,
    message: string,
    readonly diagnostics?: Record<string, string>,
  ) {
    super(message);
    this.name = "ProcessTreeTerminationError";
  }
}
export function spawnOwnedMachineProcess(
  binaryPath: string,
  options: { cwd: string; env: NodeJS.ProcessEnv; shell: false; windowsHide: true },
): { child: ChildProcessWithoutNullStreams; ownership: ProcessTreeOwnership | undefined } {
  if (process.platform === "linux") return spawnLinuxOwnedMachine(binaryPath, options);
  if (process.platform !== "win32" || process.arch !== "x64")
    throw new Error("Machine process ownership requires a supported Linux or Windows x64 host.");
  const wrapperPath = fileURLToPath(new URL("../../native/windows-x64.exe", import.meta.url));
  const child = spawn(wrapperPath, [], {
    ...options,
    detached: false,
    env: { ...options.env, [WINDOWS_JOB_TARGET]: binaryPath },
    stdio: ["pipe", "pipe", "pipe"],
  });
  return { child, ownership: { kind: "windows-job-wrapper" } };
}
export async function terminateProcessTree(
  child: ChildProcess,
  ownership?: ProcessTreeOwnership,
): Promise<void> {
  if (!ownership) return;
  if (ownership.kind === "linux-supervisor") {
    ownership.stop();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        ownership.completion,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("cleanup timeout")), TERMINATION_TIMEOUT_MS);
        }),
      ]);
    } catch (error) {
      throw new ProcessTreeTerminationError(
        "linux_owner_unconfirmed",
        "Linux owned process cleanup could not be confirmed.",
        ownership.diagnostics ?? linuxOwnerErrorDetails(error),
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    return;
  }
  if (child.exitCode !== null || child.signalCode !== null) return;
  const signalled = child.kill("SIGKILL");
  if (!signalled && child.exitCode === null && child.signalCode === null)
    throw new ProcessTreeTerminationError(
      "windows_wrapper_kill_failed",
      "Windows owned-job cleanup could not terminate its controlling process.",
    );
}
