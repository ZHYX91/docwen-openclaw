import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, mkdirSync, writeFileSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { isSupportedDocWenVersion } from "./fetch-docwen-release.mjs";
import { loadCandidate } from "./release-candidate.mjs";
import { verifyTarballBuffer, RELEASE_TARBALL_FILENAME } from "./release-package-lib.mjs";
import { createReleaseWork, finishReleaseWork } from "./release-work.mjs";

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const RAW_ACCEPTANCE_ENVIRONMENT = Object.freeze([
  "DOCWEN_MACHINE_D2_CANDIDATE",
  "DOCWEN_TEST_BINARY",
  "DOCWEN_TEST_SHA256",
  "DOCWEN_TEST_SIZE_BYTES",
  "DOCWEN_TEST_VERSION",
  "DOCWEN_PLUGIN_CANDIDATE_DIR",
  "DOCWEN_PLUGIN_D2_ROOT",
]);

export function expectedBinaryName(platform = process.platform) {
  return platform === "win32" ? "DocWenCLI.exe" : "DocWenCLI";
}

export async function validateDocWenPackageCandidate(environment) {
  const binaryPath = requiredEnvironment(environment, "DOCWEN_TEST_BINARY");
  const expectedSha256 = requiredEnvironment(environment, "DOCWEN_TEST_SHA256");
  const sizeSource = requiredEnvironment(environment, "DOCWEN_TEST_SIZE_BYTES");
  const productVersion = requiredEnvironment(environment, "DOCWEN_TEST_VERSION");
  if (!isAbsolute(binaryPath)) throw new Error("docwen_acceptance_binary_must_be_absolute");
  if (basename(binaryPath) !== expectedBinaryName()) throw new Error("docwen_acceptance_binary_name_invalid");
  if (!SHA256_PATTERN.test(expectedSha256)) throw new Error("docwen_acceptance_sha256_invalid");
  if (!/^(?:0|[1-9]\d*)$/u.test(sizeSource)) throw new Error("docwen_acceptance_size_invalid");
  const expectedSize = Number(sizeSource);
  if (!Number.isSafeInteger(expectedSize) || expectedSize <= 0) {
    throw new Error("docwen_acceptance_size_invalid");
  }
  if (!isSupportedDocWenVersion(productVersion)) throw new Error("docwen_acceptance_version_invalid");

  const sourceInfo = await lstat(binaryPath);
  if (sourceInfo.isSymbolicLink() || !sourceInfo.isFile())
    throw new Error("docwen_acceptance_binary_not_regular");
  const canonicalPath = await realpath(binaryPath);
  const canonicalInfo = await lstat(canonicalPath);
  if (canonicalInfo.isSymbolicLink() || !canonicalInfo.isFile()) {
    throw new Error("docwen_acceptance_binary_not_regular");
  }
  if (sourceInfo.size !== canonicalInfo.size || canonicalInfo.size !== expectedSize) {
    throw new Error("docwen_acceptance_size_mismatch");
  }
  const actualSha256 = await sha256File(canonicalPath);
  if (actualSha256 !== expectedSha256) throw new Error("docwen_acceptance_sha256_mismatch");
  return Object.freeze({
    binaryPath: canonicalPath,
    productVersion,
    sha256: actualSha256,
    sizeBytes: expectedSize,
  });
}

export async function runPackageAcceptance(environment = process.env) {
  const candidate = await validateDocWenPackageCandidate(environment);
  const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const pluginDirectory = requiredEnvironment(environment, "DOCWEN_PLUGIN_CANDIDATE_DIR");
  if (!isAbsolute(pluginDirectory)) throw new Error("plugin_candidate_directory_must_be_absolute");
  const plugin = loadCandidate(pluginDirectory);
  const packageBytes = plugin.files.get(RELEASE_TARBALL_FILENAME);
  const entries = verifyTarballBuffer(packageBytes).entries;
  const vitestEntrypoint = join(repositoryRoot, "node_modules", "vitest", "vitest.mjs");
  const childEnvironment = Object.fromEntries(
    Object.entries(environment).filter(
      ([name]) =>
        !RAW_ACCEPTANCE_ENVIRONMENT.some((blocked) => blocked.toLowerCase() === name.toLowerCase()) &&
        !/^(DOCWEN_(DATA_DIR|CONFIG_DIR|LOG_DIR|LOG_TO_TEMP)|TEMP|TMP|TMPDIR)$/iu.test(name),
    ),
  );
  childEnvironment.DOCWEN_MACHINE_D2_CANDIDATE = candidate.binaryPath;
  const work = createReleaseWork(repositoryRoot);
  let success = false;
  try {
    const pluginRoot = join(work.root, "plugin");
    for (const [relative, bytes] of entries) {
      const target = join(pluginRoot, ...relative.split("/"));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes, { flag: "wx" });
    }
    const temporary = join(work.root, "temp");
    mkdirSync(temporary);
    childEnvironment.TEMP = temporary;
    childEnvironment.TMP = temporary;
    childEnvironment.TMPDIR = temporary;
    childEnvironment.DOCWEN_PLUGIN_D2_ROOT = pluginRoot;
    childEnvironment.DOCWEN_DATA_DIR = join(work.root, "profile");
    delete childEnvironment.DOCWEN_CONFIG_DIR;
    delete childEnvironment.DOCWEN_LOG_DIR;
    delete childEnvironment.DOCWEN_LOG_TO_TEMP;
    const result = spawnSync(
      process.execPath,
      [vitestEntrypoint, "run", "src/docwen/machine-client.integration.test.ts"],
      { cwd: repositoryRoot, env: childEnvironment, shell: false, stdio: "inherit", windowsHide: true },
    );
    const postflight = await validateDocWenPackageCandidate(environment);
    if (!sameIdentity(candidate, postflight)) throw new Error("docwen_acceptance_identity_changed");
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`docwen_acceptance_failed:${String(result.status)}`);
    const pluginAfter = loadCandidate(pluginDirectory);
    if (
      !pluginAfter.files.get(RELEASE_TARBALL_FILENAME).equals(packageBytes) ||
      JSON.stringify(pluginAfter.record) !== JSON.stringify(plugin.record)
    )
      throw new Error("plugin_acceptance_identity_changed");
    for (const [relative, expected] of entries) {
      if (
        (await sha256File(join(pluginRoot, ...relative.split("/")))) !==
        createHash("sha256").update(expected).digest("hex")
      ) {
        throw new Error("plugin_extracted_candidate_changed");
      }
    }
    process.stdout.write(
      `Packaged DocWen accepted: ${candidate.binaryPath} (${candidate.sizeBytes} bytes, ${candidate.sha256}, ${candidate.productVersion}); plugin ${plugin.record.package.sha256}.\n`,
    );
    success = true;
  } finally {
    finishReleaseWork(work, success);
  }
}

function requiredEnvironment(environment, name) {
  const value = environment[name];
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name}_required`);
  return value;
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function sameIdentity(left, right) {
  return (
    left.binaryPath === right.binaryPath &&
    left.productVersion === right.productVersion &&
    left.sha256 === right.sha256 &&
    left.sizeBytes === right.sizeBytes
  );
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  runPackageAcceptance().catch((error) => {
    process.stderr.write(
      `Packaged DocWen acceptance failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
  });
}
