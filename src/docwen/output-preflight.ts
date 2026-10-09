import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { DocWenMachineError } from "./machine-client.js";
import { publishPathNoReplace } from "./publish-path.js";
import { cleanupPublicationPath, isErrno, newPublication, publicationFailure } from "./publication.js";

/** Test the real filesystem with private entries before starting expensive work.
 * Commit-time publication and identity checks remain authoritative. */
export async function preflightPublication(
  destination: string,
  kind: "file" | "directory",
  signal?: AbortSignal,
): Promise<void> {
  const publication = newPublication();
  let root: string | undefined;
  let identity: { dev: bigint; ino: bigint } | undefined;
  let failure: unknown;
  try {
    signal?.throwIfAborted();
    let parent = path.dirname(destination);
    while (true) {
      try {
        const stat = await lstat(parent);
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
          throw new DocWenMachineError(
            "docwen_output_not_directory",
            "Output parent must be a real directory.",
          );
        }
        break;
      } catch (error) {
        if (!isErrno(error, "ENOENT") || path.dirname(parent) === parent) throw error;
        parent = path.dirname(parent);
      }
    }
    root = await mkdtemp(path.join(parent, ".docwen-preflight-"));
    identity = await lstat(root, { bigint: true });
    const source = path.join(root, "source");
    const target = path.join(root, "target");
    if (kind === "directory") await mkdir(source);
    else await writeFile(source, "", { flag: "wx" });
    await publishPathNoReplace(source, target, kind);
    if (kind === "directory") await mkdir(source);
    try {
      await publishPathNoReplace(source, target, kind);
      throw Object.assign(new Error("The filesystem did not prevent replacement."), { code: "ENOTSUP" });
    } catch (error) {
      if (!isErrno(error, "EEXIST") && !isErrno(error, "ENOTEMPTY")) throw error;
    }
    signal?.throwIfAborted();
  } catch (error) {
    const unsupported = ["ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EINVAL", "EXDEV"].some((code) =>
      isErrno(error, code),
    );
    failure = unsupported
      ? new DocWenMachineError(
          "docwen_output_filesystem_unsupported",
          "This filesystem cannot safely publish the output. Choose another folder; in WSL, try a native Linux filesystem.",
          { system_code: (error as NodeJS.ErrnoException).code },
        )
      : error;
  } finally {
    if (root) {
      await cleanupPublicationPath(root, publication, "staging_cleanup_failed", async (target) => {
        const current = await lstat(target, { bigint: true });
        if (
          !identity ||
          !current.isDirectory() ||
          current.isSymbolicLink() ||
          current.dev !== identity.dev ||
          current.ino !== identity.ino
        ) {
          throw new Error("Output probe identity changed; the directory was preserved.");
        }
        await rm(target, { recursive: true, force: true });
      });
    }
  }
  if (failure || publication.warnings.length > 0) {
    throw publicationFailure(
      failure ??
        new DocWenMachineError(
          "docwen_output_preflight_failed",
          "Output probe cleanup failed. Check the selected output folder.",
        ),
      publication,
    );
  }
}
