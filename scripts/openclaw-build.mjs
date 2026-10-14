import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function validateOpenClawBuildInput(pkg, lock, installed) {
  const version = lock?.packages?.["node_modules/openclaw"]?.version;
  if (
    lock?.lockfileVersion !== 3 ||
    typeof version !== "string" ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u.test(version) ||
    lock.packages["node_modules/openclaw"].link === true
  ) {
    throw new Error("release_openclaw_lock_invalid");
  }
  if (
    pkg?.devDependencies?.openclaw !== version ||
    lock.packages[""]?.devDependencies?.openclaw !== version
  ) {
    throw new Error("release_openclaw_dependency_mismatch");
  }
  if (
    pkg?.openclaw?.build?.openclawVersion !== version ||
    pkg?.openclaw?.build?.pluginSdkVersion !== version
  ) {
    throw new Error("release_openclaw_build_invalid");
  }
  if (installed !== undefined && (installed?.name !== "openclaw" || installed?.version !== version)) {
    throw new Error("release_openclaw_installed_mismatch");
  }
  return version;
}

function readPackage(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("release_openclaw_input_not_regular");
  return JSON.parse(readFileSync(path, "utf8"));
}

export function verifyOpenClawBuildInput(repoRoot, { requireInstalled = false } = {}) {
  return validateOpenClawBuildInput(
    readPackage(join(repoRoot, "package.json")),
    readPackage(join(repoRoot, "package-lock.json")),
    requireInstalled ? readPackage(join(repoRoot, "node_modules", "openclaw", "package.json")) : undefined,
  );
}
