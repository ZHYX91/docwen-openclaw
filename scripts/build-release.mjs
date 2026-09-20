import console from "node:console";
import { lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { URL, fileURLToPath } from "node:url";

import {
  RELEASE_TARBALL_FILENAME,
  SHA256SUMS_FILENAME,
  assertExternalOutputDirectory,
  assertReleaseToolchain,
  buildReleaseCandidate,
  formatSha256Sums,
  verifyTarballBuffer,
} from "./release-package-lib.mjs";
import { createReleaseWork, finishReleaseWork } from "./release-work.mjs";

function main() {
  if (process.argv.length !== 3)
    throw new Error("usage:npm run release:build -- <absolute-output-directory>");
  const repoRoot = fileURLToPath(new URL("../", import.meta.url));
  const outputDirectory = assertExternalOutputDirectory(repoRoot, process.argv[2]);
  const npmCli = process.env.npm_execpath;
  assertReleaseToolchain(npmCli);

  const outputParent = dirname(outputDirectory);
  mkdirSync(outputParent, { recursive: true });
  if (lstatExists(outputDirectory)) {
    const stat = lstatSync(outputDirectory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("release_output_not_regular_directory");
  } else {
    mkdirSync(outputDirectory);
  }

  const tarballOutput = join(outputDirectory, RELEASE_TARBALL_FILENAME);
  const checksumOutput = join(outputDirectory, SHA256SUMS_FILENAME);
  if (lstatExists(tarballOutput) || lstatExists(checksumOutput)) {
    throw new Error("release_output_asset_already_exists");
  }

  const work = createReleaseWork(repoRoot);
  let candidate;
  try {
    candidate = buildReleaseCandidate(repoRoot, work.root, npmCli);
  } catch (error) {
    finishReleaseWork(work, false);
    throw error;
  }
  finishReleaseWork(work, true);

  verifyTarballBuffer(candidate.tarball);
  writeFileSync(tarballOutput, candidate.tarball, { flag: "wx", mode: 0o644 });
  try {
    writeFileSync(checksumOutput, formatSha256Sums(candidate.sha256), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o644,
    });
  } catch (error) {
    rmSync(tarballOutput, { force: true });
    throw error;
  }

  const written = verifyTarballBuffer(readFileSync(tarballOutput));
  const expectedChecksum = formatSha256Sums(written.sha256);
  if (readFileSync(checksumOutput, "utf8") !== expectedChecksum) {
    throw new Error("release_checksum_write_mismatch");
  }
  console.log(`Release asset: ${tarballOutput}`);
  console.log(`Checksum manifest: ${checksumOutput}`);
  console.log(`SHA-256: ${written.sha256}`);
}

function lstatExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

main();
