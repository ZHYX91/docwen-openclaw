import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";
import { validateOpenClawBuildInput } from "./openclaw-build.mjs";
import { buildReleaseCandidate } from "./release-package-lib.mjs";
import { createReleaseWork, finishReleaseWork } from "./release-work.mjs";

function inputs() {
  return {
    pkg: {
      devDependencies: { openclaw: "2026.9.9" },
      openclaw: { build: { openclawVersion: "2026.9.9", pluginSdkVersion: "2026.9.9" } },
    },
    lock: {
      lockfileVersion: 3,
      packages: {
        "": { devDependencies: { openclaw: "2026.9.9" } },
        "node_modules/openclaw": { version: "2026.9.9" },
      },
    },
    installed: { name: "openclaw", version: "2026.9.9" },
  };
}

describe("OpenClaw build input", () => {
  it("binds both build declarations to the locked and installed SDK", () => {
    const { pkg, lock, installed } = inputs();
    expect(validateOpenClawBuildInput(pkg, lock, installed)).toBe("2026.9.9");
  });

  it("rejects jointly stale build declarations even when they agree", () => {
    const { pkg, lock, installed } = inputs();
    pkg.openclaw.build = { openclawVersion: "2026.9.5", pluginSdkVersion: "2026.9.5" };
    expect(() => validateOpenClawBuildInput(pkg, lock, installed)).toThrow("release_openclaw_build_invalid");
  });

  it("rejects jointly stale dependency and build declarations against the resolved lock entry", () => {
    const { pkg, lock, installed } = inputs();
    pkg.devDependencies.openclaw = "2026.9.5";
    lock.packages[""].devDependencies.openclaw = "2026.9.5";
    pkg.openclaw.build = { openclawVersion: "2026.9.5", pluginSdkVersion: "2026.9.5" };
    expect(() => validateOpenClawBuildInput(pkg, lock, installed)).toThrow(
      "release_openclaw_dependency_mismatch",
    );
  });

  it("rejects a stale or incorrectly named installed package", () => {
    const { pkg, lock } = inputs();
    for (const installed of [
      { name: "openclaw", version: "2026.9.5" },
      { name: "another-package", version: "2026.9.9" },
    ]) {
      expect(() => validateOpenClawBuildInput(pkg, lock, installed)).toThrow(
        "release_openclaw_installed_mismatch",
      );
    }
  });

  it("requires a resolved package entry rather than only matching declarations", () => {
    const { pkg, lock, installed } = inputs();
    delete lock.packages["node_modules/openclaw"];
    expect(() => validateOpenClawBuildInput(pkg, lock, installed)).toThrow("release_openclaw_lock_invalid");
  });

  it("checks the installed SDK before creating or compiling a candidate", () => {
    const work = createReleaseWork(process.cwd());
    let success = false;
    try {
      const repo = join(work.root, "repository");
      mkdirSync(join(repo, "node_modules", "openclaw"), { recursive: true });
      for (const file of ["package.json", "package-lock.json"]) {
        writeFileSync(join(repo, file), readFileSync(file));
      }
      writeFileSync(
        join(repo, "node_modules", "openclaw", "package.json"),
        JSON.stringify({ name: "openclaw", version: "2026.9.5" }),
      );
      const candidateWork = join(work.root, "candidate");
      expect(() => buildReleaseCandidate(repo, candidateWork, "not-invoked")).toThrow(
        "release_openclaw_installed_mismatch",
      );
      expect(existsSync(candidateWork)).toBe(false);
      success = true;
    } finally {
      finishReleaseWork(work, success);
    }
  });
});
