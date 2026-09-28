import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const TERMINATION_TIMEOUT_MS = 2_000;
const TERMINATION_POLL_MS = 20;
const WINDOWS_JOB_TARGET = "OPENCLAW_DOCWEN_JOB_TARGET";

export type ProcessTreeOwnership =
  | Readonly<{ kind: "windows-job-wrapper" }>
  | Readonly<{ kind: "windows-tree"; rootPid: number }>
  | Readonly<{ kind: "posix-process-group"; processGroupId: number }>;

export type ProcessTreeTerminationReason =
  | "windows_wrapper_kill_failed"
  | "windows_root_exited"
  | "taskkill_failed"
  | "taskkill_timeout"
  | "process_group_kill_failed"
  | "process_group_still_alive";

export class ProcessTreeTerminationError extends Error {
  constructor(
    readonly reason: ProcessTreeTerminationReason,
    message: string,
  ) {
    super(message);
    this.name = "ProcessTreeTerminationError";
  }
}

export function spawnOwnedMachineProcess(
  binaryPath: string,
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    shell: false;
    windowsHide: true;
  },
): { child: ChildProcessWithoutNullStreams; ownership: ProcessTreeOwnership } {
  if (process.platform === "win32") {
    if (process.arch !== "x64") throw new Error("The Windows Machine process owner requires x64.");
    const wrapperPath = fileURLToPath(new URL("../../native/windows-x64.exe", import.meta.url));
    const child = spawn(wrapperPath, [], {
      ...options,
      detached: false,
      env: { ...options.env, [WINDOWS_JOB_TARGET]: binaryPath },
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { child, ownership: { kind: "windows-job-wrapper" } };
  }

  const child = spawn(binaryPath, ["serve", "--stdio"], {
    ...options,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (!child.pid) throw new Error("DocWen Machine process did not expose a process id.");
  return {
    child,
    ownership: { kind: "posix-process-group", processGroupId: child.pid },
  };
}

export function captureProcessTreeOwnership(
  child: ChildProcess,
  detached: boolean,
): ProcessTreeOwnership | undefined {
  if (!child.pid) return undefined;
  if (process.platform === "win32") return { kind: "windows-tree", rootPid: child.pid };
  if (!detached) {
    throw new Error("POSIX process-tree ownership requires a dedicated detached process group.");
  }
  return { kind: "posix-process-group", processGroupId: child.pid };
}

export async function terminateProcessTree(
  child: ChildProcess,
  ownership: ProcessTreeOwnership | undefined = liveProcessTreeOwnership(child),
): Promise<void> {
  if (!ownership) return;
  if (ownership.kind === "windows-job-wrapper") {
    terminateWindowsJobWrapper(child);
    return;
  }
  if (ownership.kind === "windows-tree") {
    await terminateWindowsTree(child, ownership.rootPid);
    return;
  }
  await terminatePosixProcessGroup(ownership.processGroupId);
}

function liveProcessTreeOwnership(child: ChildProcess): ProcessTreeOwnership | undefined {
  if (hasExited(child) || !child.pid) return undefined;
  return process.platform === "win32"
    ? { kind: "windows-tree", rootPid: child.pid }
    : { kind: "posix-process-group", processGroupId: child.pid };
}

function terminateWindowsJobWrapper(child: ChildProcess): void {
  if (hasExited(child)) return;
  const signalled = child.kill("SIGKILL");
  if (!signalled && !hasExited(child)) {
    throw new ProcessTreeTerminationError(
      "windows_wrapper_kill_failed",
      "Windows owned-job cleanup could not terminate its controlling process.",
    );
  }
}

async function terminateWindowsTree(child: ChildProcess, rootPid: number): Promise<void> {
  if (hasExited(child)) {
    throw new ProcessTreeTerminationError(
      "windows_root_exited",
      "The Windows process-tree root exited before owned-tree cleanup could be confirmed.",
    );
  }
  const killer = spawn("taskkill.exe", ["/PID", String(rootPid), "/T", "/F"], {
    shell: false,
    windowsHide: true,
    stdio: "ignore",
  });
  let outcome: { kind: "close"; code: number | null } | { kind: "timeout" };
  try {
    outcome = await Promise.race([
      once(killer, "close").then(([code]) => ({ kind: "close" as const, code: code as number | null })),
      delay(TERMINATION_TIMEOUT_MS).then(() => ({ kind: "timeout" as const })),
    ]);
  } catch {
    throw new ProcessTreeTerminationError(
      "taskkill_failed",
      "Windows process-tree cleanup failed before completion could be confirmed.",
    );
  }
  if (outcome.kind === "timeout") {
    if (!hasExited(killer)) killer.kill();
    throw new ProcessTreeTerminationError(
      "taskkill_timeout",
      "Windows process-tree cleanup did not settle within its cleanup deadline.",
    );
  }
  if (outcome.code !== 0) {
    throw new ProcessTreeTerminationError(
      "taskkill_failed",
      "Windows process-tree cleanup did not report success.",
    );
  }
}

async function terminatePosixProcessGroup(processGroupId: number): Promise<void> {
  try {
    process.kill(-processGroupId, "SIGKILL");
  } catch (error) {
    if (isErrno(error, "ESRCH")) return;
    throw new ProcessTreeTerminationError(
      "process_group_kill_failed",
      "POSIX process-group cleanup could not signal the owned process group.",
    );
  }

  const deadline = Date.now() + TERMINATION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!(await processGroupHasLiveMember(processGroupId))) return;
    await delay(TERMINATION_POLL_MS);
  }
  if (!(await processGroupHasLiveMember(processGroupId))) return;
  throw new ProcessTreeTerminationError(
    "process_group_still_alive",
    "POSIX process-group cleanup did not settle within its cleanup deadline.",
  );
}

async function processGroupHasLiveMember(processGroupId: number): Promise<boolean> {
  if (process.platform !== "linux") return processGroupExists(processGroupId);

  let entries;
  try {
    entries = await readdir("/proc", { withFileTypes: true });
  } catch {
    return processGroupExists(processGroupId);
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) continue;
    let statText: string;
    try {
      statText = await readFile(`/proc/${entry.name}/stat`, "utf8");
    } catch (error) {
      if (isErrno(error, "ENOENT")) continue;
      return true;
    }
    const commandEnd = statText.lastIndexOf(") ");
    if (commandEnd < 0) return true;
    const fields = statText.slice(commandEnd + 2).split(" ");
    const state = fields[0];
    const group = Number(fields[2]);
    if (group === processGroupId && state !== "Z" && state !== "X") return true;
  }
  return false;
}

function processGroupExists(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    if (isErrno(error, "ESRCH")) return false;
    return true;
  }
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function isErrno(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
