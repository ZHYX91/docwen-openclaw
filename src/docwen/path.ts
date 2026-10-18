import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { basename, isAbsolute, normalize } from "node:path";

import { DocWenMachineError } from "./machine-client.js";

export async function resolveDocWenBinary(binaryPath?: string): Promise<string> {
  const raw = binaryPath?.trim() ?? "";
  if (!raw)
    throw new DocWenMachineError(
      "docwen_binary_path_required",
      "Set plugins.entries.docwen.config.binaryPath to the full path of DocWenCLI on the Gateway computer.",
    );
  if (!isAbsolute(raw))
    throw new DocWenMachineError(
      "docwen_binary_path_must_be_absolute",
      "binaryPath must be a full absolute path to DocWenCLI on the Gateway computer.",
    );
  const resolved = normalize(raw);
  const name = basename(resolved);
  const nameIsValid =
    process.platform === "win32" ? name.toLowerCase() === "docwencli.exe" : name === "DocWenCLI";
  if (!nameIsValid)
    throw new DocWenMachineError(
      "docwen_binary_name_invalid",
      `Choose the ${process.platform === "win32" ? "DocWenCLI.exe" : "DocWenCLI"} executable in your DocWen installation.`,
    );
  try {
    if (!(await stat(resolved)).isFile())
      throw new DocWenMachineError(
        "docwen_binary_not_file",
        "binaryPath points to a folder or another non-file entry. Choose the DocWenCLI executable itself.",
      );
  } catch (error) {
    if (error instanceof DocWenMachineError) throw error;
    throw new DocWenMachineError(
      "docwen_binary_not_found",
      "Cannot find or read DocWenCLI at binaryPath. Check the installation path and file permissions on the Gateway computer.",
    );
  }
  if (process.platform !== "win32") {
    try {
      await access(resolved, constants.X_OK);
    } catch {
      throw new DocWenMachineError(
        "docwen_binary_not_executable",
        "DocWenCLI does not have execute permission. Grant execute permission to the installed file, then try again.",
      );
    }
  }
  return resolved;
}
