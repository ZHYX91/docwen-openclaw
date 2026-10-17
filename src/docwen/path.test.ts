import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveDocWenBinary } from "./path.js";
import { executeDocWenTool } from "./client.js";

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
    await expect(resolveDocWenBinary()).rejects.toMatchObject({ code: "docwen_binary_path_required" });
    await expect(resolveDocWenBinary("   ")).rejects.toMatchObject({ code: "docwen_binary_path_required" });
    await expect(resolveDocWenBinary(binaryName)).rejects.toMatchObject({
      code: "docwen_binary_path_must_be_absolute",
    });
    await expect(resolveDocWenBinary(join(tmpdir(), "missing", binaryName))).rejects.toMatchObject({
      code: "docwen_binary_not_found",
    });
    await expect(resolveDocWenBinary(join(tmpdir(), wrongName))).rejects.toMatchObject({
      code: "docwen_binary_name_invalid",
    });
    if (process.platform !== "win32") {
      await expect(resolveDocWenBinary(join(tmpdir(), "docwencli"))).rejects.toMatchObject({
        code: "docwen_binary_name_invalid",
      });
    }
  });

  it.skipIf(process.platform === "win32")("rejects a non-executable Unix binary", async () => {
    const root = await mkdtemp(join(tmpdir(), "docwen-non-executable-"));
    roots.push(root);
    const binary = join(root, "DocWenCLI");
    await writeFile(binary, "fixture", { mode: 0o644 });
    await expect(resolveDocWenBinary(binary)).rejects.toMatchObject({ code: "docwen_binary_not_executable" });
  });

  it.each(["docwen_info", "docwen_convert"])(
    "returns an actionable configuration error from %s",
    async (toolName) => {
      const result = await executeDocWenTool(toolName, {}, {});
      expect(result).toMatchObject({
        status: "failed",
        error: {
          code: "docwen_binary_path_required",
          message: expect.stringContaining("plugins.entries.docwen.config.binaryPath"),
        },
        diagnostic_summary: {
          error_code: "docwen_binary_path_required",
          error_category: "configuration",
          recovery_action: "check_binary_configuration",
        },
      });
      if (toolName === "docwen_convert") {
        expect(result).toMatchObject({ publication: { state: "not_published" } });
      } else {
        expect(result).not.toHaveProperty("publication");
      }
    },
  );
});
