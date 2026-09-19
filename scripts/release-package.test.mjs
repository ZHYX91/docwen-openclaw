import { Buffer } from "node:buffer";
import { dirname, join } from "node:path";
import process from "node:process";
import { gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import {
  RELEASE_FILES,
  RELEASE_TARBALL_FILENAME,
  assertExternalOutputDirectory,
  formatSha256Sums,
  verifyTarballBuffer,
} from "./release-package-lib.mjs";

const BLOCK_SIZE = 512;
const PORTABLE_MTIME_SECONDS = 499_162_500;

function writeOctal(header, offset, length, value) {
  const encoded = value.toString(8).padStart(length - 1, "0");
  header.write(encoded, offset, length - 1, "ascii");
  header[offset + length - 1] = 0;
}

function packageJson(overrides = {}) {
  return JSON.stringify({
    name: "@zhyx91/openclaw-docwen",
    version: "2.0.0",
    type: "module",
    license: "MIT",
    main: "dist/index.js",
    types: "dist/index.d.ts",
    files: [
      "dist",
      "native/linux-x64.node",
      "openclaw.plugin.json",
      "openclaw-config.example.json5",
      "skills",
      "README.md",
      "LICENSE",
    ],
    openclaw: {
      extensions: ["./dist/index.js"],
      compat: {
        pluginApi: ">=2026.7.1-2 <2027.0.0",
        minGatewayVersion: "2026.7.1-2",
      },
      build: {
        openclawVersion: "2026.7.1-2",
        pluginSdkVersion: "2026.7.1-2",
      },
    },
    peerDependencies: { openclaw: ">=2026.7.1-2 <2027.0.0" },
    ...overrides,
  });
}

function entryContents(path, packageOverrides = {}) {
  if (path === "package.json") return Buffer.from(packageJson(packageOverrides));
  if (path === "openclaw.plugin.json") {
    return Buffer.from(JSON.stringify({ id: "docwen", name: "DocWen", version: "2.0.0" }));
  }
  return Buffer.from(`${path}\n`);
}

function tarHeader(path, contents, { mode = 0o644, type = "0" } = {}) {
  const header = Buffer.alloc(BLOCK_SIZE);
  const archivePath = `package/${path}`;
  if (Buffer.byteLength(archivePath) > 100) throw new Error("test_path_too_long");
  header.write(archivePath, 0, 100, "utf8");
  writeOctal(header, 100, 8, mode);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, contents.length);
  writeOctal(header, 136, 12, PORTABLE_MTIME_SECONDS);
  header.fill(0x20, 148, 156);
  header.write(type, 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "latin1");
  header.write("00", 263, 2, "ascii");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(checksum.toString(8).padStart(6, "0"), 148, 6, "ascii");
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function makeTarball({
  paths = RELEASE_FILES,
  replacePath,
  modeByPath = new Map(),
  typeByPath = new Map(),
  packageOverrides = {},
} = {}) {
  const blocks = [];
  for (const originalPath of paths) {
    const path = replacePath?.get(originalPath) ?? originalPath;
    const contents = entryContents(originalPath, packageOverrides);
    blocks.push(
      tarHeader(path, contents, {
        mode: modeByPath.get(originalPath),
        type: typeByPath.get(originalPath),
      }),
    );
    blocks.push(contents);
    const padding = Math.ceil(contents.length / BLOCK_SIZE) * BLOCK_SIZE - contents.length;
    if (padding > 0) blocks.push(Buffer.alloc(padding));
  }
  blocks.push(Buffer.alloc(BLOCK_SIZE * 2));
  const compressed = gzipSync(Buffer.concat(blocks), { level: 9, mtime: 0 });
  compressed[9] = 0xff;
  return compressed;
}

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
