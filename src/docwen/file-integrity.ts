import { createReadStream, type BigIntStats } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, readdir, readlink } from "node:fs/promises";
import * as path from "node:path";
import { DocWenMachineError } from "./machine-client.js";
import { isErrno } from "./publication.js";

export type PathIdentity = Readonly<{
  dev: bigint;
  ino: bigint;
  mode: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}>;

export type DirectorySnapshot = Readonly<{
  root: PathIdentity;
  treeSha256: string;
}>;

export async function assertPathIdentityUnchanged(
  destination: string,
  expected: PathIdentity,
): Promise<void> {
  let current: BigIntStats;
  try {
    current = await lstat(destination, { bigint: true });
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      throw new DocWenMachineError("docwen_output_changed", "The output target disappeared during commit.");
    }
    throw error;
  }
  if (!samePathIdentity(current, expected)) {
    throw new DocWenMachineError("docwen_output_changed", "The output target changed during commit.");
  }
}

export async function captureDirectorySnapshot(directory: string): Promise<DirectorySnapshot> {
  const before = await lstat(directory, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new DocWenMachineError("docwen_output_not_directory", "Bundle output must be a real directory.");
  }
  const root = pathIdentity(before);
  const hash = createHash("sha256");
  await hashDirectoryTree(directory, "", hash);
  const after = await lstat(directory, { bigint: true });
  if (!samePathIdentity(after, root)) {
    throw new DocWenMachineError(
      "docwen_output_changed",
      "The output target changed while it was inspected.",
    );
  }
  return { root: pathIdentity(after), treeSha256: hash.digest("hex") };
}

export async function assertDirectorySnapshotUnchanged(
  directory: string,
  expected: DirectorySnapshot,
): Promise<void> {
  let current: DirectorySnapshot;
  try {
    current = await captureDirectorySnapshot(directory);
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      throw new DocWenMachineError("docwen_output_changed", "The output target disappeared during commit.");
    }
    throw error;
  }
  if (
    !samePathIdentityFromSnapshot(current.root, expected.root) ||
    current.treeSha256 !== expected.treeSha256
  ) {
    throw new DocWenMachineError("docwen_output_changed", "The output contents changed during commit.");
  }
}

async function hashDirectoryTree(
  root: string,
  relativeDirectory: string,
  hash: ReturnType<typeof createHash>,
): Promise<void> {
  const directory = relativeDirectory ? path.join(root, ...relativeDirectory.split("/")) : root;
  const names = (await readdir(directory)).sort((left, right) => left.localeCompare(right, "en"));
  for (const name of names) {
    const relative = relativeDirectory ? `${relativeDirectory}/${name}` : name;
    const fullPath = path.join(root, ...relative.split("/"));
    const before = await lstat(fullPath, { bigint: true });
    const identity = pathIdentity(before);
    if (before.isSymbolicLink()) {
      const target = await readlink(fullPath);
      const after = await lstat(fullPath, { bigint: true });
      if (!samePathIdentity(after, identity)) {
        throw new DocWenMachineError(
          "docwen_output_changed",
          "An output link changed while it was inspected.",
        );
      }
      hash.update(`L\0${relative}\0${identity.mode}\0${target}\n`);
      continue;
    }
    if (before.isDirectory()) {
      hash.update(`D\0${relative}\0${identity.dev}\0${identity.ino}\0${identity.mode}\n`);
      await hashDirectoryTree(root, relative, hash);
      const after = await lstat(fullPath, { bigint: true });
      if (!samePathIdentity(after, identity)) {
        throw new DocWenMachineError(
          "docwen_output_changed",
          "An output directory changed while it was inspected.",
        );
      }
      continue;
    }
    if (before.isFile()) {
      const digest = await hashFile(fullPath);
      const after = await lstat(fullPath, { bigint: true });
      if (!samePathIdentity(after, identity)) {
        throw new DocWenMachineError(
          "docwen_output_changed",
          "An output file changed while it was inspected.",
        );
      }
      hash.update(
        `F\0${relative}\0${identity.mode}\0${identity.size}\0${identity.mtimeNs}\0${identity.ctimeNs}\0${digest}\n`,
      );
      continue;
    }
    hash.update(
      `O\0${relative}\0${identity.dev}\0${identity.ino}\0${identity.mode}\0${identity.size}\0${identity.mtimeNs}\0${identity.ctimeNs}\n`,
    );
  }
}

function samePathIdentityFromSnapshot(left: PathIdentity, right: PathIdentity): boolean {
  // Renaming the output directory into our private backup changes the root
  // directory ctime on normal filesystems. The move is already bound by
  // dev/ino and the remaining stable root metadata; the recursive tree hash
  // protects child entries and file contents.
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs
  );
}

export async function assertSourceVersionUnchanged(
  destination: string,
  before: BigIntStats,
  expected: { sizeBytes: number; sha256: string },
): Promise<PathIdentity> {
  if (before.size !== BigInt(expected.sizeBytes)) {
    throw new DocWenMachineError(
      "docwen_source_changed",
      "The source file changed while DocWen was preparing the in-place result.",
    );
  }
  const digest = await hashFile(destination);
  const after = await lstat(destination, { bigint: true });
  if (!samePathIdentity(after, pathIdentity(before)) || digest !== expected.sha256) {
    throw new DocWenMachineError(
      "docwen_source_changed",
      "The source file changed while DocWen was preparing the in-place result.",
    );
  }
  return pathIdentity(after);
}

export async function assertCopiedArtifact(
  file: string,
  expectedSize: number,
  expectedSha256: string,
): Promise<void> {
  const before = await lstat(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.size !== BigInt(expectedSize)) {
    throw new DocWenMachineError(
      "docwen_machine_integrity_error",
      "Copied artifact does not match its validated size.",
    );
  }
  const digest = await hashFile(file);
  const after = await lstat(file, { bigint: true });
  if (!samePathIdentity(after, pathIdentity(before)) || digest !== expectedSha256) {
    throw new DocWenMachineError(
      "docwen_machine_integrity_error",
      "Copied artifact does not match its validated identity.",
    );
  }
}

export function pathIdentity(metadata: BigIntStats): PathIdentity {
  return {
    dev: metadata.dev,
    ino: metadata.ino,
    mode: metadata.mode,
    size: metadata.size,
    mtimeNs: metadata.mtimeNs,
    ctimeNs: metadata.ctimeNs,
  };
}

export function samePathIdentity(metadata: BigIntStats, expected: PathIdentity): boolean {
  return (
    metadata.dev === expected.dev &&
    metadata.ino === expected.ino &&
    metadata.mode === expected.mode &&
    metadata.size === expected.size &&
    metadata.mtimeNs === expected.mtimeNs &&
    metadata.ctimeNs === expected.ctimeNs
  );
}

export async function hashFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(file);
    stream.on("data", (chunk: Buffer) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolve);
  });
  return hash.digest("hex");
}
