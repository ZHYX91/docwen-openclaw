import { spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import process from "node:process";
import { gunzipSync } from "node:zlib";
import { URL } from "node:url";

export const RELEASE_NODE_VERSION = "24.19.0";
export const RELEASE_NPM_VERSION = "11.17.0";
export const PACKAGE_NAME = "@zhyx91/openclaw-docwen";
export const PACKAGE_VERSION = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;
if (
  typeof PACKAGE_VERSION !== "string" ||
  !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(PACKAGE_VERSION)
) {
  throw new Error("release_package_version_invalid");
}
export const PACKAGE_ID = `${PACKAGE_NAME}@${PACKAGE_VERSION}`;
export const NPM_TARBALL_FILENAME = `zhyx91-openclaw-docwen-${PACKAGE_VERSION}.tgz`;
export const RELEASE_TARBALL_FILENAME = `openclaw-docwen-${PACKAGE_VERSION}.tgz`;
export const SHA256SUMS_FILENAME = "SHA256SUMS";

export const RELEASE_FILES = Object.freeze(
  [
    "LICENSE",
    "README.md",
    "dist/config.d.ts",
    "dist/config.js",
    "dist/docwen/client.d.ts",
    "dist/docwen/client.js",
    "dist/docwen/diagnostics.d.ts",
    "dist/docwen/diagnostics.js",
    "dist/docwen/file-integrity.d.ts",
    "dist/docwen/file-integrity.js",
    "dist/docwen/output-lock.d.ts",
    "dist/docwen/output-lock.js",
    "dist/docwen/output-transaction.d.ts",
    "dist/docwen/output-transaction.js",
    "dist/docwen/publication.d.ts",
    "dist/docwen/publication.js",
    "dist/docwen/publish-path.d.ts",
    "dist/docwen/publish-path.js",
    "dist/docwen/machine-client.d.ts",
    "dist/docwen/machine-client.js",
    "dist/docwen/machine-framing.d.ts",
    "dist/docwen/machine-framing.js",
    "dist/docwen/path.d.ts",
    "dist/docwen/path.js",
    "dist/index.d.ts",
    "dist/index.js",
    "dist/plugin.d.ts",
    "dist/plugin.js",
    "dist/process/runner.d.ts",
    "dist/process/runner.js",
    "dist/tools/catalog.d.ts",
    "dist/tools/catalog.js",
    "dist/tools/definitions.d.ts",
    "dist/tools/definitions.js",
    "openclaw-config.example.json5",
    "native/linux-x64.node",
    "openclaw.plugin.json",
    "package.json",
    "skills/docwen/SKILL.md",
  ].sort(),
);

const RELEASE_SOURCE_FILES = RELEASE_FILES.filter((path) => !path.startsWith("dist/"));
const RELEASE_DIST_FILES = RELEASE_FILES.filter((path) => path.startsWith("dist/"));
const TAR_BLOCK_SIZE = 512;
const NPM_PORTABLE_MTIME_SECONDS = 499_162_500;
const MAX_TARBALL_BYTES = 16 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 64 * 1024 * 1024;

function fail(code, detail) {
  throw new Error(detail === undefined ? code : `${code}:${detail}`);
}

function assertPlainObject(value, code) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(code);
  return value;
}

function assertExactArray(actual, expected, code) {
  if (!Array.isArray(actual) || actual.length !== expected.length) fail(code);
  for (let index = 0; index < expected.length; index += 1) {
    if (actual[index] !== expected[index]) fail(code);
  }
}

function assertSafeRelativePath(path, code) {
  if (typeof path !== "string" || path.length === 0) fail(code);
  if (path.includes("\\") || path.startsWith("/") || path.includes("\0")) fail(code, path);
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    fail(code, path);
  }
  if (posix.normalize(path) !== path) fail(code, path);
}

function assertExactFileSet(actual, code) {
  const sorted = [...actual].sort();
  if (sorted.length !== RELEASE_FILES.length) fail(code);
  for (let index = 0; index < RELEASE_FILES.length; index += 1) {
    if (sorted[index] !== RELEASE_FILES[index]) fail(code, sorted[index]);
  }
}

function parseJsonEntry(entries, path, code) {
  const buffer = entries.get(path);
  if (!buffer) fail(code, path);
  try {
    return assertPlainObject(JSON.parse(buffer.toString("utf8")), code);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(`${code}:`)) throw error;
    fail(code, path);
  }
}

function verifyPackageIdentity(entries) {
  const pkg = parseJsonEntry(entries, "package.json", "release_package_json_invalid");
  if (pkg.name !== PACKAGE_NAME) fail("release_package_name_invalid");
  if (pkg.version !== PACKAGE_VERSION) fail("release_package_version_invalid");
  if (pkg.type !== "module" || pkg.main !== "dist/index.js" || pkg.types !== "dist/index.d.ts") {
    fail("release_package_entrypoint_invalid");
  }
  if (pkg.license !== "MIT") fail("release_package_license_invalid");
  assertExactArray(
    pkg.files,
    [
      "dist",
      "native/linux-x64.node",
      "openclaw.plugin.json",
      "openclaw-config.example.json5",
      "skills",
      "README.md",
      "LICENSE",
    ],
    "release_package_files_field_invalid",
  );

  const openclaw = assertPlainObject(pkg.openclaw, "release_openclaw_metadata_invalid");
  assertExactArray(openclaw.extensions, ["./dist/index.js"], "release_openclaw_extensions_invalid");
  const compat = assertPlainObject(openclaw.compat, "release_openclaw_compat_invalid");
  if (compat.pluginApi !== ">=2026.7.1-2 <2027.0.0" || compat.minGatewayVersion !== "2026.7.1-2") {
    fail("release_openclaw_compat_invalid");
  }
  const build = assertPlainObject(openclaw.build, "release_openclaw_build_invalid");
  if (build.openclawVersion !== "2026.7.1-2" || build.pluginSdkVersion !== "2026.7.1-2") {
    fail("release_openclaw_build_invalid");
  }
  const peers = assertPlainObject(pkg.peerDependencies, "release_peer_dependencies_invalid");
  if (peers.openclaw !== ">=2026.7.1-2 <2027.0.0" || Object.keys(peers).length !== 1) {
    fail("release_peer_dependencies_invalid");
  }

  const manifest = parseJsonEntry(entries, "openclaw.plugin.json", "release_manifest_json_invalid");
  if (manifest.id !== "docwen" || manifest.name !== "DocWen" || manifest.version !== PACKAGE_VERSION) {
    fail("release_manifest_identity_invalid");
  }
}

function parseTarString(field, code) {
  const nul = field.indexOf(0);
  const raw = nul === -1 ? field : field.subarray(0, nul);
  if (raw.includes(0)) fail(code);
  const value = raw.toString("utf8");
  if (!Buffer.from(value, "utf8").equals(raw)) fail(code);
  return value;
}

function parseTarOctal(field, code, allowEmpty = false) {
  const value = parseTarString(field, code).trim();
  if (allowEmpty && value === "") return 0;
  if (!/^[0-7]+$/.test(value)) fail(code);
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed)) fail(code);
  return parsed;
}

function verifyTarHeaderChecksum(header) {
  const expected = parseTarOctal(header.subarray(148, 156), "tar_checksum_invalid");
  let actual = 0;
  for (let index = 0; index < header.length; index += 1) {
    actual += index >= 148 && index < 156 ? 0x20 : header[index];
  }
  if (actual !== expected) fail("tar_checksum_invalid");
}

function parseTarArchive(archive) {
  if (archive.length === 0 || archive.length > MAX_UNPACKED_BYTES) fail("tar_size_invalid");
  if (archive.length % TAR_BLOCK_SIZE !== 0) fail("tar_alignment_invalid");

  const entries = new Map();
  const metadata = new Map();
  let offset = 0;
  let foundEnd = false;
  while (offset < archive.length) {
    const header = archive.subarray(offset, offset + TAR_BLOCK_SIZE);
    if (header.every((byte) => byte === 0)) {
      const next = archive.subarray(offset + TAR_BLOCK_SIZE, offset + TAR_BLOCK_SIZE * 2);
      if (next.length !== TAR_BLOCK_SIZE || !next.every((byte) => byte === 0)) {
        fail("tar_end_marker_invalid");
      }
      if (!archive.subarray(offset).every((byte) => byte === 0)) fail("tar_trailing_data_invalid");
      foundEnd = true;
      break;
    }

    verifyTarHeaderChecksum(header);
    if (header.subarray(257, 263).toString("latin1") !== "ustar\0") fail("tar_magic_invalid");
    if (header.subarray(263, 265).toString("latin1") !== "00") fail("tar_version_invalid");
    if (parseTarString(header.subarray(345, 500), "tar_prefix_invalid") !== "") {
      fail("tar_prefix_invalid");
    }

    const path = parseTarString(header.subarray(0, 100), "tar_path_invalid");
    if (!path.startsWith("package/")) fail("tar_path_unsafe", path);
    const relativePath = path.slice("package/".length);
    assertSafeRelativePath(relativePath, "tar_path_unsafe");
    if (entries.has(relativePath)) fail("tar_duplicate_entry", relativePath);

    const type = header[156];
    if (type !== 0x30) fail("tar_entry_not_regular", relativePath);
    const mode = parseTarOctal(header.subarray(100, 108), "tar_mode_invalid");
    const uid = parseTarOctal(header.subarray(108, 116), "tar_uid_invalid", true);
    const gid = parseTarOctal(header.subarray(116, 124), "tar_gid_invalid", true);
    const size = parseTarOctal(header.subarray(124, 136), "tar_entry_size_invalid");
    const mtime = parseTarOctal(header.subarray(136, 148), "tar_mtime_invalid");
    if (mode !== 0o644) fail("tar_mode_invalid", relativePath);
    if (uid !== 0 || gid !== 0) fail("tar_owner_invalid", relativePath);
    if (mtime !== NPM_PORTABLE_MTIME_SECONDS) fail("tar_mtime_invalid", relativePath);
    if (parseTarString(header.subarray(157, 257), "tar_linkname_invalid") !== "") {
      fail("tar_linkname_invalid", relativePath);
    }
    if (
      parseTarString(header.subarray(265, 297), "tar_uname_invalid") !== "" ||
      parseTarString(header.subarray(297, 329), "tar_gname_invalid") !== ""
    ) {
      fail("tar_owner_name_invalid", relativePath);
    }

    const dataStart = offset + TAR_BLOCK_SIZE;
    const dataEnd = dataStart + size;
    if (dataEnd > archive.length) fail("tar_entry_truncated", relativePath);
    const paddedEnd = dataStart + Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
    if (paddedEnd > archive.length) fail("tar_entry_truncated", relativePath);
    if (!archive.subarray(dataEnd, paddedEnd).every((byte) => byte === 0)) {
      fail("tar_padding_invalid", relativePath);
    }
    entries.set(relativePath, Buffer.from(archive.subarray(dataStart, dataEnd)));
    metadata.set(relativePath, { mode, size });
    offset = paddedEnd;
  }
  if (!foundEnd) fail("tar_end_marker_missing");
  assertExactFileSet(entries.keys(), "release_file_set_mismatch");
  verifyPackageIdentity(entries);
  return { entries, metadata };
}

export function validatePackReport(report) {
  if (!Array.isArray(report) || report.length !== 1) fail("npm_pack_report_invalid");
  const item = assertPlainObject(report[0], "npm_pack_report_invalid");
  if (
    item.id !== PACKAGE_ID ||
    item.name !== PACKAGE_NAME ||
    item.version !== PACKAGE_VERSION ||
    item.filename !== NPM_TARBALL_FILENAME
  ) {
    fail("npm_pack_identity_invalid");
  }
  if (!Array.isArray(item.files)) fail("npm_pack_files_invalid");
  const paths = [];
  const seen = new Set();
  for (const entryValue of item.files) {
    const entry = assertPlainObject(entryValue, "npm_pack_file_invalid");
    assertSafeRelativePath(entry.path, "npm_pack_path_unsafe");
    if (seen.has(entry.path)) fail("npm_pack_duplicate_file", entry.path);
    seen.add(entry.path);
    paths.push(entry.path);
    if (entry.mode !== 0o644) fail("npm_pack_mode_invalid", entry.path);
    if (!Number.isSafeInteger(entry.size) || entry.size < 0) fail("npm_pack_size_invalid", entry.path);
  }
  assertExactFileSet(paths, "npm_pack_file_set_mismatch");
  if (item.entryCount !== RELEASE_FILES.length) fail("npm_pack_entry_count_invalid");
  if (!Array.isArray(item.bundled) || item.bundled.length !== 0) fail("npm_pack_bundled_invalid");
  if (!Number.isSafeInteger(item.size) || item.size <= 0 || item.size > MAX_TARBALL_BYTES) {
    fail("npm_pack_tarball_size_invalid");
  }
  if (!Number.isSafeInteger(item.unpackedSize) || item.unpackedSize < 0) {
    fail("npm_pack_unpacked_size_invalid");
  }
  if (!/^[a-f0-9]{40}$/.test(item.shasum)) fail("npm_pack_shasum_invalid");
  if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(item.integrity)) fail("npm_pack_integrity_invalid");
  return item;
}

export function verifyTarballBuffer(tarball, expectedReport) {
  if (!Buffer.isBuffer(tarball) || tarball.length === 0 || tarball.length > MAX_TARBALL_BYTES) {
    fail("release_tarball_size_invalid");
  }
  const expectedGzipHeader = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0, 0, 0, 0, 0x02, 0xff]);
  if (!tarball.subarray(0, expectedGzipHeader.length).equals(expectedGzipHeader)) {
    fail("release_gzip_header_invalid");
  }

  let archive;
  try {
    archive = gunzipSync(tarball, { maxOutputLength: MAX_UNPACKED_BYTES });
  } catch {
    fail("release_gzip_invalid");
  }
  const parsed = parseTarArchive(archive);
  const sha256 = createHash("sha256").update(tarball).digest("hex");

  if (expectedReport !== undefined) {
    const report = validatePackReport(expectedReport);
    const sha1 = createHash("sha1").update(tarball).digest("hex");
    const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
    if (report.size !== tarball.length) fail("npm_pack_tarball_size_mismatch");
    if (report.shasum !== sha1) fail("npm_pack_shasum_mismatch");
    if (report.integrity !== integrity) fail("npm_pack_integrity_mismatch");
    const unpackedSize = [...parsed.metadata.values()].reduce((sum, entry) => sum + entry.size, 0);
    if (report.unpackedSize !== unpackedSize) fail("npm_pack_unpacked_size_mismatch");
    const reportByPath = new Map(report.files.map((entry) => [entry.path, entry]));
    for (const [path, metadata] of parsed.metadata) {
      const reported = reportByPath.get(path);
      if (reported?.mode !== metadata.mode || reported?.size !== metadata.size) {
        fail("npm_pack_entry_metadata_mismatch", path);
      }
    }
  }

  return { sha256, entries: parsed.entries };
}

export function formatSha256Sums(sha256) {
  if (!/^[a-f0-9]{64}$/.test(sha256)) fail("release_sha256_invalid");
  return `${sha256}  ${RELEASE_TARBALL_FILENAME}\n`;
}

function runChecked(command, args, options, code) {
  const result = spawnSync(command, args, {
    ...options,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    shell: false,
  });
  if (result.status !== 0) {
    const detail = result.stderr?.trim() || result.stdout?.trim() || result.error?.message;
    fail(code, detail || String(result.status));
  }
  return result.stdout;
}

export function assertReleaseToolchain(npmCli) {
  if (process.versions.node !== RELEASE_NODE_VERSION) {
    fail("release_node_version_invalid", process.versions.node);
  }
  if (typeof npmCli !== "string" || npmCli.length === 0) fail("npm_execpath_missing");
  const npmVersion = runChecked(
    process.execPath,
    [npmCli, "--version"],
    {},
    "npm_version_check_failed",
  ).trim();
  if (npmVersion !== RELEASE_NPM_VERSION) fail("release_npm_version_invalid", npmVersion);
}

export function packAndVerify(packageRoot, packDestination, npmCli, childEnvironment = process.env) {
  mkdirSync(packDestination, { recursive: true });
  const stdout = runChecked(
    process.execPath,
    [npmCli, "pack", "--ignore-scripts", "--json", "--pack-destination", packDestination],
    { cwd: packageRoot, env: childEnvironment },
    "npm_pack_failed",
  );
  let report;
  try {
    report = JSON.parse(stdout);
  } catch {
    fail("npm_pack_report_json_invalid");
  }
  const item = validatePackReport(report);
  const tarballPath = resolve(packDestination, item.filename);
  const destinationRoot = `${resolve(packDestination)}${sep}`;
  if (!tarballPath.startsWith(destinationRoot)) fail("npm_pack_output_path_unsafe");
  const stat = lstatSync(tarballPath);
  if (!stat.isFile() || stat.isSymbolicLink()) fail("npm_pack_output_not_regular");
  const tarball = readFileSync(tarballPath);
  const verified = verifyTarballBuffer(tarball, report);
  return { tarball, tarballPath, sha256: verified.sha256, report };
}

function copyReleaseSourceFile(repoRoot, packageRoot, path) {
  const source = join(repoRoot, ...path.split("/"));
  const stat = lstatSync(source);
  if (!stat.isFile() || stat.isSymbolicLink()) fail("release_source_not_regular", path);
  const destination = join(packageRoot, ...path.split("/"));
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
  chmodSync(destination, 0o644);
}

function walkRegularFiles(root, current = root) {
  const result = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const absolute = join(current, entry.name);
    if (entry.isSymbolicLink()) fail("release_build_symlink_forbidden", absolute);
    if (entry.isDirectory()) {
      result.push(...walkRegularFiles(root, absolute));
    } else if (entry.isFile()) {
      result.push(relative(root, absolute).split(sep).join("/"));
    } else {
      fail("release_build_special_file_forbidden", absolute);
    }
  }
  return result;
}

export function buildReleaseCandidate(repoRoot, workRoot, npmCli) {
  const packageRoot = join(workRoot, "package");
  const packDestination = join(workRoot, "pack");
  const temporaryDirectory = join(workRoot, "tmp");
  const npmCache = join(workRoot, "npm-cache");
  mkdirSync(packageRoot, { recursive: true });
  mkdirSync(temporaryDirectory, { recursive: true });
  mkdirSync(npmCache, { recursive: true });
  for (const path of RELEASE_SOURCE_FILES) copyReleaseSourceFile(repoRoot, packageRoot, path);

  const tscPath = join(repoRoot, "node_modules", "typescript", "bin", "tsc");
  const tscStat = lstatSync(tscPath);
  if (!tscStat.isFile() || tscStat.isSymbolicLink()) fail("release_typescript_missing");
  const environment = {
    ...process.env,
    TEMP: temporaryDirectory,
    TMP: temporaryDirectory,
    TMPDIR: temporaryDirectory,
    npm_config_cache: npmCache,
  };
  runChecked(
    process.execPath,
    [tscPath, "-p", join(repoRoot, "tsconfig.build.json"), "--outDir", join(packageRoot, "dist")],
    { cwd: repoRoot, env: environment },
    "release_typescript_build_failed",
  );
  const generatedDist = walkRegularFiles(join(packageRoot, "dist")).map((path) => `dist/${path}`);
  for (const path of generatedDist) chmodSync(join(packageRoot, ...path.split("/")), 0o644);
  const expectedDist = [...RELEASE_DIST_FILES].sort();
  const actualDist = generatedDist.sort();
  if (actualDist.length !== expectedDist.length) fail("release_dist_file_set_mismatch");
  for (let index = 0; index < expectedDist.length; index += 1) {
    if (actualDist[index] !== expectedDist[index]) fail("release_dist_file_set_mismatch", actualDist[index]);
  }

  return packAndVerify(packageRoot, packDestination, npmCli, environment);
}

export function assertExternalOutputDirectory(repoRoot, outputArgument) {
  if (typeof outputArgument !== "string" || outputArgument.length === 0) {
    fail("release_output_directory_required");
  }
  if (!isAbsolute(outputArgument)) fail("release_output_directory_must_be_absolute");
  const repository = resolveCandidateRealPath(repoRoot);
  const output = resolve(outputArgument);
  const canonicalOutput = resolveCandidateRealPath(output);
  const relation = relative(repository, canonicalOutput);
  if (relation === "" || (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation))) {
    fail("release_output_directory_inside_repository");
  }
  return output;
}

function resolveCandidateRealPath(path) {
  let current = resolve(path);
  const missingSegments = [];
  while (true) {
    try {
      return resolve(realpathSync.native(current), ...missingSegments);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      missingSegments.unshift(basename(current));
      current = parent;
    }
  }
}
