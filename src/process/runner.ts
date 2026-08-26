import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";

export async function terminateProcessTree(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.killed) return;
  if (process.platform === "win32" && child.pid) {
    const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
    });
    await Promise.race([once(killer, "close"), new Promise((resolve) => setTimeout(resolve, 2_000))]);
  } else if (child.pid) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
  if (child.exitCode === null) child.kill("SIGKILL");
}
