import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL, URL } from "node:url";

const API_VERSION = "2026-03-10";
const DOCWEN_REPOSITORY = "ZHYX91/docwen";
const PIN_SCHEMA = "docwen.openclaw.core_release.v2";
const PACKAGE_SCHEMA = "docwen.openclaw.core_package.v2";
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const DIGEST = /^sha256:([0-9a-f]{64})$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const PLATFORMS = Object.freeze(["linux", "windows"]);
const MINIMUM_VERSION = Object.freeze([0, 12, 0]);

function fail(message) {
  throw new Error(message);
}

function plainObject(value, message) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(message);
  return value;
}

function exactKeys(value, expected, message) {
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (keys.length !== wanted.length || keys.some((key, index) => key !== wanted[index])) fail(message);
}

function versionTuple(value) {
  const match = typeof value === "string" ? VERSION.exec(value) : undefined;
  if (!match) return undefined;
  const tuple = match.slice(1).map(Number);
  return compareVersion(tuple, MINIMUM_VERSION) >= 0 ? tuple : undefined;
}

function compareVersion(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function assetName(platform, version) {
  if (platform === "windows") return "DocWen-windows-x64.zip";
  if (platform === "linux") return `DocWenCLI-${version}-linux-x64.tar.gz`;
  fail("docwen_platform_invalid");
}

function assertExternalOutput(root, value) {
  if (!isAbsolute(value)) fail("output_directory_must_be_absolute");
  const output = resolve(value);
  const relation = relative(realpathSync.native(root), output);
  if (relation === "" || (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation))) {
    fail("output_directory_inside_repository");
  }
  mkdirSync(output, { recursive: false });
  const stat = lstatSync(output);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("output_directory_not_plain");
  return output;
}

async function githubJson(path, token) {
  const response = await globalThis.fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "docwen-openclaw-release-gate",
      "X-GitHub-Api-Version": API_VERSION,
    },
  });
  if (!response.ok) fail(`github_api_failed:${response.status}`);
  return response.json();
}

async function fetchDocWenReleases(token) {
  const releases = [];
  for (let page = 1; page <= 10; page += 1) {
    const batch = await githubJson(`/repos/${DOCWEN_REPOSITORY}/releases?per_page=100&page=${page}`, token);
    if (!Array.isArray(batch)) fail("github_releases_not_array");
    releases.push(...batch);
    if (batch.length < 100) return releases;
  }
  fail("github_releases_pagination_limit_exceeded");
}

function pinnedAsset(release, platform, version) {
  if (!Array.isArray(release.assets)) fail("docwen_release_assets_not_array");
  const name = assetName(platform, version);
  const matches = release.assets.filter((item) => plainObject(item, "docwen_asset_not_object").name === name);
  if (matches.length !== 1) fail(`docwen_release_asset_identity_invalid:${platform}`);
  const asset = matches[0];
  const digestMatch = typeof asset.digest === "string" ? DIGEST.exec(asset.digest) : undefined;
  if (
    !Number.isSafeInteger(asset.id) ||
    asset.id <= 0 ||
    asset.state !== "uploaded" ||
    !Number.isSafeInteger(asset.size) ||
    asset.size <= 0 ||
    !digestMatch ||
    asset.url !== `https://api.github.com/repos/${DOCWEN_REPOSITORY}/releases/assets/${asset.id}`
  ) {
    fail(`docwen_release_asset_metadata_invalid:${platform}`);
  }
  return {
    id: asset.id,
    name,
    bytes: asset.size,
    sha256: digestMatch[1],
    apiUrl: asset.url,
  };
}

export function selectPinnedRelease(releases) {
  if (!Array.isArray(releases)) fail("github_releases_not_array");
  const candidates = releases
    .map((item) => {
      const release = plainObject(item, "github_release_not_object");
      const tuple = versionTuple(release.tag_name);
      if (
        !tuple ||
        release.draft !== false ||
        release.prerelease !== false ||
        typeof release.published_at !== "string" ||
        release.published_at.length === 0 ||
        release.immutable !== true
      ) {
        return undefined;
      }
      return { release, tuple };
    })
    .filter(Boolean)
    .sort((left, right) => compareVersion(right.tuple, left.tuple));
  if (candidates.length === 0) fail("no_immutable_supported_docwen_release");
  if (candidates[1] && compareVersion(candidates[0].tuple, candidates[1].tuple) === 0) {
    fail("latest_docwen_release_ambiguous");
  }

  const { release, tuple } = candidates[0];
  const version = tuple.join(".");
  return validatePinnedRecord({
    schema: PIN_SCHEMA,
    repository: DOCWEN_REPOSITORY,
    tag: release.tag_name,
    version,
    immutable: true,
    assets: {
      linux: pinnedAsset(release, "linux", version),
      windows: pinnedAsset(release, "windows", version),
    },
  });
}

function validatePinnedAsset(value, platform, version) {
  const asset = plainObject(value, `docwen_pin_asset_not_object:${platform}`);
  exactKeys(asset, ["apiUrl", "bytes", "id", "name", "sha256"], `docwen_pin_asset_keys_invalid:${platform}`);
  if (
    !Number.isSafeInteger(asset.id) ||
    asset.id <= 0 ||
    asset.name !== assetName(platform, version) ||
    !Number.isSafeInteger(asset.bytes) ||
    asset.bytes <= 0 ||
    typeof asset.sha256 !== "string" ||
    !SHA256.test(asset.sha256) ||
    asset.apiUrl !== `https://api.github.com/repos/${DOCWEN_REPOSITORY}/releases/assets/${asset.id}`
  ) {
    fail(`docwen_pin_asset_invalid:${platform}`);
  }
  return asset;
}

export function validatePinnedRecord(value) {
  const record = plainObject(value, "docwen_pin_not_object");
  exactKeys(
    record,
    ["assets", "immutable", "repository", "schema", "tag", "version"],
    "docwen_pin_keys_invalid",
  );
  const tuple = versionTuple(record.version);
  if (
    record.schema !== PIN_SCHEMA ||
    record.repository !== DOCWEN_REPOSITORY ||
    !tuple ||
    record.tag !== record.version ||
    record.immutable !== true
  ) {
    fail("docwen_pin_identity_invalid");
  }
  const assets = plainObject(record.assets, "docwen_pin_assets_not_object");
  exactKeys(assets, PLATFORMS, "docwen_pin_platforms_invalid");
  for (const platform of PLATFORMS) validatePinnedAsset(assets[platform], platform, record.version);
  if (assets.linux.id === assets.windows.id) fail("docwen_pin_asset_ids_not_unique");
  return record;
}

function serializePinnedRecord(record) {
  return `${JSON.stringify(record)}\n`;
}

function readPinnedRecord(path) {
  if (!isAbsolute(path)) fail("docwen_pin_path_must_be_absolute");
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > 64 * 1024) {
    fail("docwen_pin_file_invalid");
  }
  const raw = readFileSync(path, "utf8");
  let record;
  try {
    record = validatePinnedRecord(JSON.parse(raw));
  } catch (error) {
    if (error instanceof SyntaxError) fail("docwen_pin_json_invalid");
    throw error;
  }
  if (raw !== serializePinnedRecord(record)) fail("docwen_pin_not_canonical");
  return record;
}

async function downloadAsset(asset, token) {
  const response = await globalThis.fetch(asset.apiUrl, {
    headers: {
      Accept: "application/octet-stream",
      Authorization: `Bearer ${token}`,
      "User-Agent": "docwen-openclaw-release-gate",
      "X-GitHub-Api-Version": API_VERSION,
    },
    redirect: "follow",
  });
  if (!response.ok) fail(`docwen_asset_download_failed:${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function resolveRelease(output, token) {
  const record = selectPinnedRelease(await fetchDocWenReleases(token));
  writeFileSync(join(output, "DOCWEN-CORE.json"), serializePinnedRecord(record), {
    encoding: "utf8",
    flag: "wx",
    mode: 0o644,
  });
  process.stdout.write(serializePinnedRecord(record));
}

async function fetchRelease(platform, output, pinnedPath, token) {
  const record = readPinnedRecord(pinnedPath);
  const pinned = record.assets[platform];
  const bytes = await downloadAsset(pinned, token);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (bytes.length !== pinned.bytes || sha256 !== pinned.sha256) {
    fail("docwen_release_asset_bytes_mismatch");
  }
  const path = join(output, pinned.name);
  writeFileSync(path, bytes, { flag: "wx", mode: 0o644 });
  const packageRecord = {
    schema: PACKAGE_SCHEMA,
    tag: record.tag,
    version: record.version,
    immutable: true,
    platform,
    asset: {
      name: pinned.name,
      path,
      bytes: bytes.length,
      sha256,
    },
  };
  writeFileSync(join(output, "docwen-release.json"), `${JSON.stringify(packageRecord)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o644,
  });
  process.stdout.write(`${JSON.stringify(packageRecord)}\n`);
}

async function main() {
  const token = process.env.GH_TOKEN;
  if (!token) fail("GH_TOKEN_required");
  const repositoryRoot = realpathSync.native(fileURLToPath(new URL("../", import.meta.url)));
  if (process.argv.length === 4 && process.argv[2] === "resolve") {
    await resolveRelease(assertExternalOutput(repositoryRoot, process.argv[3]), token);
    return;
  }
  if (process.argv.length === 6 && process.argv[2] === "fetch" && PLATFORMS.includes(process.argv[3])) {
    await fetchRelease(
      process.argv[3],
      assertExternalOutput(repositoryRoot, process.argv[4]),
      process.argv[5],
      token,
    );
    return;
  }
  fail(
    "usage:node scripts/fetch-docwen-release.mjs resolve <absolute-output-directory> | fetch <windows|linux> <absolute-output-directory> <absolute-DOCWEN-CORE.json>",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
