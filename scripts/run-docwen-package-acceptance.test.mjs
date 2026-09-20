import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  expectedBinaryName,
  runPackageAcceptance,
  validateDocWenPackageCandidate,
} from "./run-docwen-package-acceptance.mjs";
import { makeCandidate } from "./testing/candidate-fixtures.mjs";

const ownedDirectories = [];

afterEach(async () => {
  await Promise.all(ownedDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("plugin archive used by the acceptance wrapper", () => {
  it("refuses an omitted, relative or tampered plugin candidate", async () => {
    const environment = await candidateEnvironment();
    await expect(runPackageAcceptance(environment)).rejects.toThrow("DOCWEN_PLUGIN_CANDIDATE_DIR_required");
    await expect(
      runPackageAcceptance({ ...environment, DOCWEN_PLUGIN_CANDIDATE_DIR: "relative" }),
    ).rejects.toThrow("plugin_candidate_directory_must_be_absolute");
    const plugin = join(dirname(environment.DOCWEN_TEST_BINARY), "plugin");
    makeCandidate(plugin);
    await writeFile(join(plugin, "SHA256SUMS"), "changed");
    await expect(
      runPackageAcceptance({ ...environment, DOCWEN_PLUGIN_CANDIDATE_DIR: plugin }),
    ).rejects.toThrow("candidate_checksum_mismatch");
  });

  it("loads the archived client into the real runner and isolates inherited profile selectors", async () => {
    // This is a wrapper test with an inert binary and a deliberately synthetic client,
    // not evidence that the actual DocWen product accepts this package.
    const environment = await candidateEnvironment();
    const root = dirname(environment.DOCWEN_TEST_BINARY);
    const plugin = join(root, "plugin");
    const marker = join(root, "archive-client.json");
    const source = [
      'import { Buffer } from "node:buffer";',
      'import { createHash } from "node:crypto";',
      'import { readFileSync, writeFileSync } from "node:fs";',
      'import { join } from "node:path";',
      'import process from "node:process";',
      'const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");',
      "export async function runDocWenMachineTask({ request }) {",
      "  writeFileSync(process.env.ARCHIVE_CLIENT_TEST_MARKER, JSON.stringify({ module: import.meta.url, profile: process.env.DOCWEN_DATA_DIR, config: process.env.DOCWEN_CONFIG_DIR ?? null }));",
      '  const markdown = request.capability_id === "convert.docx.to_markdown";',
      "  if (!markdown) {",
      "    const neutral = JSON.parse(readFileSync(request.inputs[0].locator.path));",
      "    for (const resource of neutral.document.resources) {",
      '      if (hash(Buffer.from(resource.content_base64, "base64")) !== resource.sha256) throw new Error("resource integrity mismatch");',
      "    }",
      "  }",
      '  const bytes = Buffer.from(markdown ? "Architecture ^h-7f3a\\nFigure: System overview ^system-overview" : "synthetic DOCX for wrapper test");',
      '  const locator = markdown ? "output.md" : "output.docx";',
      "  const absolutePath = join(request.output.staging_root.path, locator);",
      "  writeFileSync(absolutePath, bytes);",
      '  return { progress: [{}], bundle: { artifacts: [{ kind: "document", media_type: markdown ? "text/markdown" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document", locator, absolutePath, size_bytes: bytes.length, sha256: hash(bytes) }] } };',
      "}",
    ].join("\n");
    makeCandidate(plugin, {
      contentsByPath: new Map([["dist/docwen/machine-client.js", Buffer.from(source)]]),
    });
    await runPackageAcceptance({
      ...process.env,
      ...environment,
      DOCWEN_PLUGIN_CANDIDATE_DIR: plugin,
      ARCHIVE_CLIENT_TEST_MARKER: marker,
      DOCWEN_DATA_DIR: join(root, "ambient-profile"),
      docwen_config_dir: join(root, "ambient-config"),
      DOCWEN_PLUGIN_D2_ROOT: join(root, "untrusted-client"),
    });
    const observed = JSON.parse(await readFile(marker, "utf8"));
    const archivedModule = fileURLToPath(observed.module);
    expect(archivedModule.endsWith(join("plugin", "dist", "docwen", "machine-client.js"))).toBe(true);
    expect(observed.profile).not.toBe(join(root, "ambient-profile"));
    expect(observed.config).toBeNull();
    await expect(readFile(archivedModule)).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);
});

async function candidateEnvironment() {
  const directory = await mkdtemp(join(tmpdir(), "openclaw-docwen-acceptance-"));
  ownedDirectories.push(directory);
  const binaryPath = join(directory, expectedBinaryName());
  const contents = Buffer.from("exact packaged DocWen candidate", "utf8");
  await writeFile(binaryPath, contents, { mode: 0o700 });
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
