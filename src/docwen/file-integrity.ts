import { createReadStream, type BigIntStats } from "node:fs";
import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
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
