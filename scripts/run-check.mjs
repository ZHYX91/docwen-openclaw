import { spawnSync } from "node:child_process";
import process from "node:process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { verifyOpenClawBuildInput } from "./openclaw-build.mjs";
import { assertReleaseToolchain } from "./release-package-lib.mjs";

export function runRepositoryChecks({
  repoRoot = process.cwd(),
  npmCli = process.env.npm_execpath,
  mode = "all",
  environment = process.env,
} = {}) {
  const steps =
    mode === "source"
      ? ["lint", "format:check", "typecheck", "test:coverage", "audit:prod"]
      : mode === "all"
        ? ["check:source", "build", "package:check"]
        : undefined;
  if (!steps) throw new Error("repository_check_mode_invalid");
  assertReleaseToolchain(npmCli);
  verifyOpenClawBuildInput(repoRoot, { requireInstalled: true });
  for (const step of steps) {
    const result = spawnSync(process.execPath, [npmCli, "run", step], {
      cwd: repoRoot,
      env: environment,
      shell: false,
      stdio: "inherit",
      windowsHide: true,
    });
    if (result.status !== 0) return result.status ?? 1;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = runRepositoryChecks({ mode: process.argv[2] ?? "all" });
}
