import { spawnSync } from "node:child_process";
import process from "node:process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { verifyOpenClawBuildInput } from "./openclaw-build.mjs";
import { assertReleaseToolchain } from "./release-package-lib.mjs";

export function runRepositoryChecks({
  repoRoot = process.cwd(),
  npmCli = process.env.npm_execpath,
  mode = "all",
  environment = process.env,
} = {}) {
  const commands =
    mode === "source"
      ? ["lint", "format:check", "typecheck", "test:coverage", "audit:prod"].map((step) => ["run", step])
      : mode === "all"
        ? ["check:source", "build", "package:check"].map((step) => ["run", step])
        : mode === "build"
          ? [["run", "clean"]]
          : mode === "audit"
            ? [["audit", "--omit=dev", "--audit-level=high"]]
            : undefined;
  if (!commands) throw new Error("repository_check_mode_invalid");
  assertReleaseToolchain(npmCli);
  if (mode !== "audit") verifyOpenClawBuildInput(repoRoot, { requireInstalled: true });
  const run = (args) => {
    const result = spawnSync(process.execPath, args, {
      cwd: repoRoot,
      env: environment,
      shell: false,
      stdio: "inherit",
      windowsHide: true,
    });
    return result.status ?? 1;
  };
  for (const args of commands) {
    const status = run([npmCli, ...args]);
    if (status !== 0) return status;
  }
  if (mode === "build") {
    return run([join(repoRoot, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.build.json"]);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = runRepositoryChecks({ mode: process.argv[2] ?? "all" });
}
