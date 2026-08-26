import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { basename, isAbsolute, normalize } from "node:path";

export async function resolveDocWenBinary(binaryPath?: string): Promise<string> {
  const raw = binaryPath?.trim() ?? "";
  if (!raw) throw new Error("docwen_binary_path_required");
  if (!isAbsolute(raw)) throw new Error("docwen_binary_path_must_be_absolute");
  const resolved = normalize(raw);
  const name = basename(resolved);
  const nameIsValid =
    process.platform === "win32" ? name.toLowerCase() === "docwencli.exe" : name === "DocWenCLI";
  if (!nameIsValid) throw new Error("docwen_binary_name_invalid");
  try {
    if (!(await stat(resolved)).isFile()) throw new Error("docwen_binary_not_file");
  } catch (error) {
    if (error instanceof Error && error.message === "docwen_binary_not_file") throw error;
    throw new Error("docwen_binary_not_found", { cause: error });
  }
  if (process.platform !== "win32") {
    try {
      await access(resolved, constants.X_OK);
    } catch (error) {
      throw new Error("docwen_binary_not_executable", { cause: error });
    }
  }
  return resolved;
}
