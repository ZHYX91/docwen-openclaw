import { dirname, join } from "node:path";
import process from "node:process";
import { makeTarball } from "./testing/release-fixtures.mjs";

import { describe, expect, it } from "vitest";

import {
  RELEASE_FILES,
  RELEASE_TARBALL_FILENAME,
  assertExternalOutputDirectory,
  formatSha256Sums,
  verifyTarballBuffer,
} from "./release-package-lib.mjs";

describe("release tarball verification", () => {
  it("accepts the exact regular-file package contract", () => {
    const result = verifyTarballBuffer(makeTarball());
    expect([...result.entries.keys()].sort()).toEqual(RELEASE_FILES);
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects a missing canonical package file", () => {
    expect(() => verifyTarballBuffer(makeTarball({ paths: RELEASE_FILES.slice(1) }))).toThrow(
      "release_file_set_mismatch",
    );
  });

  it("rejects unexpected source or cache content", () => {
    expect(() => verifyTarballBuffer(makeTarball({ paths: [...RELEASE_FILES, "src/leak.ts"] }))).toThrow(
      "release_file_set_mismatch",
    );
  });

  it("rejects traversal paths before comparing the allowlist", () => {
    expect(() =>
      verifyTarballBuffer(makeTarball({ replacePath: new Map([["LICENSE", "../outside-license"]]) })),
    ).toThrow("tar_path_unsafe");
  });

  it("rejects links and executable file modes", () => {
    expect(() => verifyTarballBuffer(makeTarball({ typeByPath: new Map([["LICENSE", "2"]]) }))).toThrow(
      "tar_entry_not_regular",
    );
    expect(() => verifyTarballBuffer(makeTarball({ modeByPath: new Map([["LICENSE", 0o755]]) }))).toThrow(
      "tar_mode_invalid",
    );
  });

  it("rejects a package identity or OpenClaw compatibility mutation", () => {
    expect(() => verifyTarballBuffer(makeTarball({ packageOverrides: { version: "2.0.1" } }))).toThrow(
      "release_package_version_invalid",
    );
    expect(() =>
      verifyTarballBuffer(
        makeTarball({
          packageOverrides: {
            openclaw: {
              extensions: ["./dist/index.js"],
              compat: { pluginApi: "*", minGatewayVersion: "2026.7.1-2" },
              build: {
                openclawVersion: "2026.7.1-2",
                pluginSdkVersion: "2026.7.1-2",
              },
            },
          },
        }),
      ),
    ).toThrow("release_openclaw_compat_invalid");
  });

  it("formats one stable GNU-style checksum line for the official asset", () => {
    const checksum = "a".repeat(64);
    expect(formatSha256Sums(checksum)).toBe(`${checksum}  ${RELEASE_TARBALL_FILENAME}\n`);
  });

  it("requires an explicit output directory outside the repository", () => {
    const repository = process.cwd();
    expect(() => assertExternalOutputDirectory(repository, "relative-output")).toThrow(
      "release_output_directory_must_be_absolute",
    );
    expect(() => assertExternalOutputDirectory(repository, join(repository, "release-output"))).toThrow(
      "release_output_directory_inside_repository",
    );
    const external = join(dirname(repository), "openclaw-release-output-not-created");
    expect(assertExternalOutputDirectory(repository, external)).toBe(external);
  });
});
