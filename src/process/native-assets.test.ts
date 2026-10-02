import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import { LINUX_OWNER_SHA256 } from "./linux-owner.js";

describe("native process ownership assets", () => {
  it("binds the Linux lifetime owner to reviewed source, payload and runtime digest", async () => {
    const record = JSON.parse(await readFile("native/LINUX-OWNER-BUILD.json", "utf8")) as {
      sourceSha256: string;
      binarySha256: string;
      binaryBytes: number;
      platform: string;
      arch: string;
    };
    const source = await readFile("native/linux-owner.c");
    const binary = await readFile("native/linux-owner-x64");
    expect(record).toMatchObject({
      platform: "linux",
      arch: "x64",
      sourceSha256: sha256(source),
      binarySha256: sha256(binary),
      binaryBytes: binary.length,
    });
    expect(sha256(binary)).toBe(LINUX_OWNER_SHA256);
    expect(binary.subarray(0, 6)).toEqual(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]));
    expect(binary.readUInt16LE(18)).toBe(62);
  });
  it("binds the checked-in Windows controller to its reviewed source and provenance", async () => {
    const record = JSON.parse(await readFile("native/WINDOWS-BUILD.json", "utf8")) as {
      sourceSha256: string;
      defSha256: string;
      binarySha256: string;
      platform: string;
      arch: string;
      timestamp: number;
      binaryBytes: number;
    };
    const source = await readFile("native/windows-job.c");
    const definitions = await readFile("native/windows-job.def");
    const binary = await readFile("native/windows-x64.exe");

    expect(record).toMatchObject({
      platform: "win32",
      arch: "x64",
      timestamp: 0,
      sourceSha256: sha256(source),
      defSha256: sha256(definitions),
      binarySha256: sha256(binary),
    });
    expect(binary.length).toBe(record.binaryBytes);
    const pe = binary.readUInt32LE(0x3c);
    expect(binary.subarray(pe, pe + 4)).toEqual(Buffer.from([0x50, 0x45, 0, 0]));
    expect(binary.readUInt16LE(pe + 4)).toBe(0x8664);
    expect(binary.readUInt32LE(pe + 8)).toBe(0);
    expect(binary.subarray(0, 2).toString("ascii")).toBe("MZ");
  });
});

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
