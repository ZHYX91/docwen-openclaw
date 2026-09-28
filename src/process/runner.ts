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
  | "process_group_state_unconfirmed"
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
): { child: ChildProcessWithoutNullStreams; ownership: ProcessTreeOwnership | undefined } {
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
  return {
    child,
    // A failed spawn still emits an asynchronous error. Return its ChildProcess
    // so the session can install its error listener before the next event turn.
    ownership: child.pid ? { kind: "posix-process-group", processGroupId: child.pid } : undefined,
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
    if ((await processGroupState(processGroupId)) === "gone") return;
    await delay(TERMINATION_POLL_MS);
  }
  const state = await processGroupState(processGroupId);
  if (state === "gone") return;
  throw new ProcessTreeTerminationError(
    state === "live" ? "process_group_still_alive" : "process_group_state_unconfirmed",
    "POSIX process-group cleanup could not be confirmed within its cleanup deadline.",
  );
}

type GroupState = "gone" | "live" | "unconfirmed";

async function processGroupState(processGroupId: number): Promise<GroupState> {
  // ESRCH is authoritative even when unrelated procfs entries cannot be read.
  if (!processGroupExists(processGroupId)) return "gone";
  if (process.platform !== "linux") return "live";

  let entries;
  try {
    entries = await readdir("/proc", { withFileTypes: true });
  } catch {
    return processGroupExists(processGroupId) ? "unconfirmed" : "gone";
  }
  let uncertain = false;
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) continue;
    const member = await linuxProcessIdentity(entry.name);
    if (member === "gone") continue;
    if (member === "unconfirmed") {
      uncertain = true;
      continue;
    }
    if (member.group === processGroupId && !["Z", "X", "x"].includes(member.state)) return "live";
  }
  if (!processGroupExists(processGroupId)) return "gone";
  return uncertain ? "unconfirmed" : "gone";
}

async function linuxProcessIdentity(
  pid: string,
): Promise<{ group: number; state: string } | "gone" | "unconfirmed"> {
  try {
    const statText = await readFile(`/proc/${pid}/stat`, "utf8");
    const commandEnd = statText.lastIndexOf(") ");
    const fields =
      commandEnd < 0
        ? []
        : statText
            .slice(commandEnd + 2)
            .trim()
            .split(/\s+/u);
    const group = Number(fields[2]);
    if (fields[0] && /^[A-Za-z]$/u.test(fields[0]) && Number.isSafeInteger(group) && group >= 0) {
      return { group, state: fields[0] };
    }
  } catch (error) {
    if (isErrno(error, "ENOENT") || isErrno(error, "ESRCH")) return "gone";
  }
  // The kernel's status view supplies the same procfs-namespace PGID as stat;
  // the first NSpgid value precedes any descendant PID-namespace IDs.
  // A readable status can prove a denied stat belongs to an unrelated group.
  // If both views are unavailable, retain uncertainty rather than inventing
  // either a live member or successful cleanup.
  try {
    const status = await readFile(`/proc/${pid}/status`, "utf8");
    const groupText = /^NSpgid:\s*(\d+)(?:[\t ]+\d+)*[\t ]*$/mu.exec(status)?.[1];
    const state = /^State:[\t ]+([A-Za-z])(?:[\t ]|$)/mu.exec(status)?.[1];
    const group = Number(groupText);
    if (groupText !== undefined && state && Number.isSafeInteger(group) && group >= 0) {
      return { group, state };
    }
  } catch (error) {
    if (isErrno(error, "ENOENT") || isErrno(error, "ESRCH")) return "gone";
  }
  return "unconfirmed";
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
