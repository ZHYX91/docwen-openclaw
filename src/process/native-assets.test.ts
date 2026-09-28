import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("native process ownership assets", () => {
  it("binds the checked-in Windows controller to its reviewed source and provenance", async () => {
    const record = JSON.parse(await readFile("native/WINDOWS-BUILD.json", "utf8")) as {
      sourceSha256: string;
      defSha256: string;
      binarySha256: string;
      platform: string;
      arch: string;
      timestamp: number;
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
    expect(binary.length).toBe(3_072);
    expect(binary.subarray(0, 2).toString("ascii")).toBe("MZ");
  });
});

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
