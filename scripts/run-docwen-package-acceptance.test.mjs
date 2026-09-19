import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { expectedBinaryName, validateDocWenPackageCandidate } from "./run-docwen-package-acceptance.mjs";

const ownedDirectories = [];

afterEach(async () => {
  await Promise.all(ownedDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function candidateEnvironment() {
  const directory = await mkdtemp(join(tmpdir(), "openclaw-docwen-acceptance-"));
  ownedDirectories.push(directory);
  const binaryPath = join(directory, expectedBinaryName());
  const contents = Buffer.from("exact packaged DocWen candidate", "utf8");
  await writeFile(binaryPath, contents);
  return {
    DOCWEN_TEST_BINARY: binaryPath,
    DOCWEN_TEST_SHA256: createHash("sha256").update(contents).digest("hex"),
    DOCWEN_TEST_SIZE_BYTES: String(contents.length),
    DOCWEN_TEST_VERSION: "0.12.0",
  };
}

describe("packaged DocWen acceptance identity", () => {
  it("accepts only an exact regular candidate and returns its canonical path", async () => {
    const environment = await candidateEnvironment();
    const candidate = await validateDocWenPackageCandidate(environment);

    expect(candidate.binaryPath).toBe(await realpath(environment.DOCWEN_TEST_BINARY));
    expect(candidate.sha256).toBe(environment.DOCWEN_TEST_SHA256);
    expect(candidate.sizeBytes).toBe(Number(environment.DOCWEN_TEST_SIZE_BYTES));
    expect(candidate.productVersion).toBe("0.12.0");
  });

  it.each([
    ["DOCWEN_TEST_SHA256", "0".repeat(64), "docwen_acceptance_sha256_mismatch"],
    ["DOCWEN_TEST_SIZE_BYTES", "1", "docwen_acceptance_size_mismatch"],
    ["DOCWEN_TEST_VERSION", "0.10.0", "docwen_acceptance_version_invalid"],
    ["DOCWEN_TEST_VERSION", "0.11.99", "docwen_acceptance_version_invalid"],
    ["DOCWEN_TEST_VERSION", "0.12.0-rc1", "docwen_acceptance_version_invalid"],
    ["DOCWEN_TEST_VERSION", "9007199254740992.0.0", "docwen_acceptance_version_invalid"],
  ])("rejects a mismatched %s", async (name, value, message) => {
    const environment = await candidateEnvironment();
    environment[name] = value;

    await expect(validateDocWenPackageCandidate(environment)).rejects.toThrow(message);
  });
});
