import { constants as fsConstants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, mkdtemp, rename } from "node:fs/promises";
import * as path from "node:path";

import { DocWenMachineError, type ValidatedArtifactBundle } from "./machine-client.js";
import {
  assertCopiedArtifact,
  assertDirectorySnapshotUnchanged,
  assertPathIdentityUnchanged,
  assertSourceVersionUnchanged,
  captureDirectorySnapshot,
  hashFile,
  pathIdentity,
  type DirectorySnapshot,
  type PathIdentity,
} from "./file-integrity.js";
import { acquireOutputLock } from "./output-lock.js";
import { assertDirectoryPublicationSupported, publishPathNoReplace } from "./publish-path.js";
import {
  cleanupPublicationPath,
  errorMessage,
  isErrno,
  newPublication,
  publicationFailure,
  type Publication,
} from "./publication.js";

type CommitHooks = Readonly<{
  beforeSwap?: () => Promise<void> | void;
  afterBackupMove?: (backup: string) => Promise<void> | void;
  cleanupBackup?: (backup: string) => Promise<void>;
  cleanupStaging?: (staging: string) => Promise<void>;
  signal?: AbortSignal;
}>;

type BundlePaths = { artifactPaths: string[]; preferredArtifactPath: string };
export type Published<T> = { value: T; publication: Publication };

export async function preflightOutputDirectory(
  destination: string,
  overwrite: boolean,
): Promise<DirectorySnapshot | null> {
  assertSafeDestination(destination);
  assertDirectoryPublicationSupported();
  try {
    const existing = await lstat(destination, { bigint: true });
    if (!existing.isDirectory() || existing.isSymbolicLink()) {
      throw new DocWenMachineError("docwen_output_not_directory", "Bundle output must be a real directory.");
    }
    if (!overwrite) {
      throw new DocWenMachineError(
        "docwen_output_exists",
        "Bundle output directory already exists; set overwrite=true explicitly.",
      );
    }
    return captureDirectorySnapshot(destination);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return null;
    throw error;
  }
}

export async function atomicCommitBundle(
  bundle: ValidatedArtifactBundle,
  destination: string,
  overwrite: boolean,
  hooks: CommitHooks = {},
  initialDestination?: DirectorySnapshot | null,
): Promise<Published<BundlePaths>> {
  assertSafeDestination(destination);
  await mkdir(path.dirname(destination), { recursive: true });
  return withDestinationLock(destination, async (publication, assertHeld) => {
    const expected =
      initialDestination === undefined
        ? await preflightOutputDirectory(destination, overwrite)
        : initialDestination;
    const preferred = preferredArtifact(bundle);
    const paths = bundle.artifacts.map(artifactCommitPath);
    const preferredPath = artifactCommitPath(preferred);
    const value = {
      artifactPaths: paths.map((relative) => path.join(destination, ...relative.split("/"))),
      preferredArtifactPath: path.join(destination, ...preferredPath.split("/")),
    };
    await commitTransaction(
      destination,
      "directory",
      expected?.root ?? null,
      publication,
      assertHeld,
      hooks,
      async (candidate) => {
        await mkdir(candidate);
        for (const [index, artifact] of bundle.artifacts.entries()) {
          const target = path.join(candidate, ...paths[index]!.split("/"));
          await mkdir(path.dirname(target), { recursive: true });
          await copyFile(artifact.absolutePath, target, fsConstants.COPYFILE_EXCL);
          await assertCopiedArtifact(target, artifact.size_bytes, artifact.sha256);
        }
      },
      expected ? (current) => assertDirectorySnapshotUnchanged(current, expected) : undefined,
      expected ? (backup) => assertDirectorySnapshotUnchanged(backup, expected) : undefined,
    );
    return value;
  });
}

export async function atomicReplaceFile(
  destination: string,
  replacement: string,
  expected: { sizeBytes: number; sha256: string },
  hooks: CommitHooks = {},
  expectedSource?: { sizeBytes: number; sha256: string },
): Promise<Published<string>> {
  assertSafeDestination(destination);
  return withDestinationLock(destination, async (publication, assertHeld) => {
    const existing = await lstat(destination, { bigint: true });
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw new DocWenMachineError("docwen_input_not_regular_file", "In-place target is not a regular file.");
    }
    const sourceVersion = expectedSource ?? {
      sizeBytes: Number(existing.size),
      sha256: await hashFile(destination),
    };
    const expectedDestination = await assertSourceVersionUnchanged(destination, existing, sourceVersion);
    await commitTransaction(
      destination,
      "file",
      expectedDestination,
      publication,
      assertHeld,
      hooks,
      async (candidate) => {
        await copyFile(replacement, candidate, fsConstants.COPYFILE_EXCL);
        await assertCopiedArtifact(candidate, expected.sizeBytes, expected.sha256);
        await chmod(candidate, Number(existing.mode));
      },
      undefined,
      async (backup) => {
        await assertSourceVersionUnchanged(backup, await lstat(backup, { bigint: true }), sourceVersion);
      },
    );
    return destination;
  });
}

async function commitTransaction(
  destination: string,
  kind: "file" | "directory",
  expected: PathIdentity | null,
  publication: Publication,
  assertHeld: () => void,
  hooks: CommitHooks,
  prepare: (candidate: string) => Promise<void>,
  verifyExisting?: (destination: string) => Promise<void>,
  verifyBackup?: (backup: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(path.dirname(destination), `.docwen-${path.basename(destination)}-`));
  const candidate = path.join(root, "candidate");
  const ready = path.join(root, "ready");
  const backup = path.join(root, "backup");
  let movedExisting = false;
  let phase: "prepare" | "backup" | "publish" = "prepare";
  try {
    await prepare(candidate);
    // Verify the filesystem primitive on owned paths before moving any user
    // output. For example, WSL's Windows mount can reject RENAME_NOREPLACE.
    await publishPathNoReplace(candidate, ready, kind);
    await hooks.beforeSwap?.();
    hooks.signal?.throwIfAborted();
    assertHeld();
    if (expected) {
      await assertPathIdentityUnchanged(destination, expected);
      await verifyExisting?.(destination);
      phase = "backup";
      // backup is a fresh entry in our private transaction directory.
      await rename(destination, backup);
      movedExisting = true;
      phase = "prepare";
      await hooks.afterBackupMove?.(backup);
      const relocated = await lstat(backup, { bigint: true });
      if (
        relocated.dev !== expected.dev ||
        relocated.ino !== expected.ino ||
        relocated.mode !== expected.mode ||
        relocated.size !== expected.size ||
        relocated.mtimeNs !== expected.mtimeNs
      ) {
        throw new DocWenMachineError(
          "docwen_output_changed",
          "The output target changed while moving it to backup.",
        );
      }
      await verifyBackup?.(backup);
    }
    assertHeld();
    phase = "publish";
    await publishPathNoReplace(ready, destination, kind);
    publication.state = "published";
    publication.retry = "do_not_retry";
  } catch (error) {
    if (phase !== "prepare" && !definiteNoWrite(error)) {
      publication.state = "unconfirmed";
      publication.retry = "do_not_retry";
      publication.recovery = { destination, backup: expected ? backup : undefined, staging: root };
      throw publicationFailure(error, publication);
    }
    if (movedExisting) {
      try {
        await publishPathNoReplace(backup, destination, kind);
      } catch (rollbackError) {
        publication.state = "unconfirmed";
        publication.retry = "do_not_retry";
        publication.recovery = { destination, backup, staging: root };
        throw publicationFailure(
          new DocWenMachineError(
            "docwen_commit_rollback_failed",
            "Output commit could not restore the previous target.",
            {
              cause: errorMessage(error),
              rollback_cause: errorMessage(rollbackError),
            },
          ),
          publication,
        );
      }
    }
    throw publicationFailure(
      isErrno(error, "EEXIST") || isErrno(error, "ENOTEMPTY")
        ? new DocWenMachineError("docwen_output_exists", "The output target appeared during commit.")
        : error,
      publication,
    );
  } finally {
    if (publication.state !== "unconfirmed") {
      if (movedExisting && publication.state === "published" && verifyBackup) {
        try {
          await verifyBackup(backup);
        } catch (error) {
          publication.warnings.push({
            code: "backup_cleanup_failed",
            message: `Backup changed after publication and was preserved: ${errorMessage(error)}`,
            path: backup,
          });
        }
      }
      if (
        movedExisting
        && publication.state === "published"
        && !publication.warnings.some((warning) => warning.code === "backup_cleanup_failed")
      ) {
        await cleanupPublicationPath(backup, publication, "backup_cleanup_failed", hooks.cleanupBackup);
      }
      // Preserve a backup that failed cleanup or changed after publication; a recursive parent removal would
      // silently undo the warning and discard the only recoverable old output.
      if (!publication.warnings.some((warning) => warning.code === "backup_cleanup_failed")) {
        await cleanupPublicationPath(root, publication, "staging_cleanup_failed", hooks.cleanupStaging);
      } else {
        await cleanupPublicationPath(candidate, publication, "staging_cleanup_failed", hooks.cleanupStaging);
        await cleanupPublicationPath(ready, publication, "staging_cleanup_failed", hooks.cleanupStaging);
      }
    }
  }
}

function definiteNoWrite(error: unknown): boolean {
  return [
    "EEXIST",
    "ENOTEMPTY",
    "EACCES",
    "EPERM",
    "EINVAL",
    "ENOTSUP",
    "ENOSYS",
    "EXDEV",
    "ENOENT",
    "ENOTDIR",
    "EISDIR",
    "EBUSY",
    "EROFS",
    "ENOSPC",
    "EDQUOT",
    "ENAMETOOLONG",
    "ELOOP",
    "EMLINK",
  ].some((code) => isErrno(error, code));
}

async function withDestinationLock<T>(
  destination: string,
  body: (publication: Publication, assertHeld: () => void) => Promise<T>,
): Promise<Published<T>> {
  const publication = newPublication();
  let lock;
  try {
    lock = await acquireOutputLock(destination);
  } catch (error) {
    throw publicationFailure(
      new DocWenMachineError(
        isErrno(error, "EADDRINUSE") ? "docwen_output_busy" : "docwen_output_lock_failed",
        isErrno(error, "EADDRINUSE")
          ? "Another DocWen write is already targeting this path."
          : "Unable to acquire the output lock.",
        { cause: errorMessage(error) },
      ),
      publication,
    );
  }
  try {
    lock.assertHeld();
    return { value: await body(publication, () => lock.assertHeld()), publication };
  } catch (error) {
    throw publicationFailure(error, publication);
  } finally {
    try {
      await lock.close();
    } catch (error) {
      publication.warnings.push({ code: "lock_cleanup_failed", message: errorMessage(error) });
    }
  }
}

export function artifactCommitPath(artifact: ValidatedArtifactBundle["artifacts"][number]): string {
  if (artifact.logical_path === undefined) {
    throw new DocWenMachineError(
      "docwen_bundle_shape_invalid",
      "Artifact Bundle v3 is missing a validated logical path.",
    );
  }
  return artifact.logical_path;
}

export function preferredArtifact(bundle: ValidatedArtifactBundle) {
  const entry = bundle.entries.find((item) => item.preferred === true);
  const artifact = bundle.artifacts.find((item) => item.artifact_id === entry?.artifact_id);
  if (!artifact)
    throw new DocWenMachineError("docwen_bundle_shape_invalid", "Bundle preferred entry is invalid.");
  return artifact;
}

function assertSafeDestination(destination: string): void {
  if (!path.isAbsolute(destination))
    throw new DocWenMachineError("docwen_path_not_absolute", "Output path must be absolute.");
  const resolved = path.resolve(destination);
  if (resolved === path.parse(resolved).root)
    throw new DocWenMachineError("docwen_output_too_broad", "A filesystem root cannot be an output target.");
}
