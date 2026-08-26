import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveDocWenBinary } from "./path.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("DocWen binary path", () => {
  it("accepts only an existing absolute executable with the expected name", async () => {
    const root = await mkdtemp(join(tmpdir(), "docwen 空格-路径-"));
    roots.push(root);
    const binaryName = process.platform === "win32" ? "DocWenCLI.exe" : "DocWenCLI";
    const binary = join(root, binaryName);
    await writeFile(binary, "fixture");
    if (process.platform !== "win32") await chmod(binary, 0o755);
    await expect(resolveDocWenBinary(binary)).resolves.toBe(binary);
  });

  it("rejects relative, missing, and wrong-name paths", async () => {
    const binaryName = process.platform === "win32" ? "DocWenCLI.exe" : "DocWenCLI";
    const wrongName = process.platform === "win32" ? "python.exe" : "python";
    await expect(resolveDocWenBinary()).rejects.toThrow("docwen_binary_path_required");
    await expect(resolveDocWenBinary("   ")).rejects.toThrow("docwen_binary_path_required");
    await expect(resolveDocWenBinary(binaryName)).rejects.toThrow("docwen_binary_path_must_be_absolute");
    await expect(resolveDocWenBinary(join(tmpdir(), "missing", binaryName))).rejects.toThrow(
      "docwen_binary_not_found",
    );
    await expect(resolveDocWenBinary(join(tmpdir(), wrongName))).rejects.toThrow(
      "docwen_binary_name_invalid",
    );
    if (process.platform !== "win32") {
      await expect(resolveDocWenBinary(join(tmpdir(), "docwencli"))).rejects.toThrow(
        "docwen_binary_name_invalid",
      );
    }
  });

  it.skipIf(process.platform === "win32")("rejects a non-executable Unix binary", async () => {
    const root = await mkdtemp(join(tmpdir(), "docwen-non-executable-"));
    roots.push(root);
    const binary = join(root, "DocWenCLI");
    await writeFile(binary, "fixture", { mode: 0o644 });
    await expect(resolveDocWenBinary(binary)).rejects.toThrow("docwen_binary_not_executable");
  });
});
