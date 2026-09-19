import { link, lstat, rename } from "node:fs/promises";
import { createRequire } from "node:module";
import { getSystemErrorName } from "node:util";

type DirectoryBinding = { renameDirectory(source: string, destination: string): number };
let binding: DirectoryBinding | undefined;

export function assertDirectoryPublicationSupported(): void {
  if (process.platform === "win32") return;
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw Object.assign(new Error("Atomic directory publication requires Windows or Linux x64."), {
      code: "ENOTSUP",
    });
  }
  binding ??= createRequire(import.meta.url)("../../native/linux-x64.node") as DirectoryBinding;
}

/** The caller retains ownership of source until cleanup. Files use link() so
 * neither a competing writer nor rollback can overwrite an intervening file. */
export async function publishPathNoReplace(
  source: string,
  destination: string,
  kind: "file" | "directory",
): Promise<void> {
  if (kind === "file") {
    await link(source, destination);
    return;
  }
  assertDirectoryPublicationSupported();
  if (process.platform === "win32") {
    // Windows rejects replacing an existing directory, including an empty one.
    try {
      await rename(source, destination);
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        ["EPERM", "EACCES"].includes(String(error.code))
      ) {
        // Diagnose Windows' generic access error after the failed operation;
        // this read is never used as an alternative to atomic publication.
        if (
          await lstat(destination).then(
            () => true,
            () => false,
          )
        ) {
          throw Object.assign(new Error("The publication target already exists."), { code: "EEXIST" });
        }
      }
      throw error;
    }
    return;
  }
  const errno = binding!.renameDirectory(source, destination);
  if (errno !== 0) {
    const code = getSystemErrorName(-errno);
    throw Object.assign(new Error(`Atomic directory publication failed: ${code}`), { code });
  }
}
