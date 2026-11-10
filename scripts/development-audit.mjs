import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { assessDevelopmentAudit } from "./audit-policy.mjs";

export const DEVELOPMENT_AUDIT_ARGS = ["audit", "--include=dev", "--audit-level=moderate", "--json"];

export function runDevelopmentAudit(repoRoot, npmCli, environment) {
  const result = spawnSync(process.execPath, [npmCli, ...DEVELOPMENT_AUDIT_ARGS], {
    cwd: repoRoot,
    env: environment,
    shell: false,
    windowsHide: true,
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  // Preserve the complete unfiltered npm result in CI logs, including rejected reports.
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  try {
    if (result.error || result.signal || ![0, 1].includes(result.status))
      throw new Error("dependency_audit_process_failed");
    const report = JSON.parse(result.stdout);
    const lock = JSON.parse(readFileSync(join(repoRoot, "package-lock.json"), "utf8"));
    const assessment = assessDevelopmentAudit(report, lock);
    if (result.status === 1 && assessment.accepted === 0)
      throw new Error("dependency_audit_exit_inconsistent");
    console.log(JSON.stringify({ developmentAudit: assessment, exceptionExpires: "2026-12-10T00:00:00Z" }));
    return 0;
  } catch (error) {
    console.error(error.message);
    return 1;
  }
}
