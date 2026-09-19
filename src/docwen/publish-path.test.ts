import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { publishPathNoReplace } from "./publish-path.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function workspace() {
  const root = await mkdtemp(path.join(tmpdir(), "docwen-publication-"));
  roots.push(root);
  return root;
}

describe("filesystem publication without replacement", () => {
  it("ships a binary bound to its reviewed source", async () => {
    const root = new URL("../../native/", import.meta.url);
    const record = JSON.parse(await readFile(new URL("BUILD.json", root), "utf8"));
    const digest = async (name: string) =>
      createHash("sha256")
        .update(await readFile(new URL(name, root)))
        .digest("hex");
    expect(await digest("rename-directory.c")).toBe(record.sourceSha256);
    expect(await digest("linux-x64.node")).toBe(record.binarySha256);
  });

  it.each(["file", "directory"] as const)(
    "rejects an existing %s at the actual filesystem operation",
    async (kind) => {
      const root = await workspace();
      const source = path.join(root, "candidate");
      const destination = path.join(root, "existing");
      if (kind === "directory") {
        await mkdir(source);
        await mkdir(destination);
      } else {
        await writeFile(source, "candidate");
        await writeFile(destination, "intervening writer");
      }
      const before = await lstat(destination, { bigint: true });
      await expect(publishPathNoReplace(source, destination, kind)).rejects.toBeDefined();
      const after = await lstat(destination, { bigint: true });
      expect(after.ino).toBe(before.ino);
      expect(after.ctimeNs).toBe(before.ctimeNs);
      if (kind === "directory") expect(await readdir(destination)).toEqual([]);
      else expect(await readFile(destination, "utf8")).toBe("intervening writer");
    },
  );
});
