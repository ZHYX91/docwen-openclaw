import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { preflightPublication } from "./output-preflight.js";
import { preflightOutputDirectory } from "./output-transaction.js";
import * as publisher from "./publish-path.js";
import { diagnosticSummary } from "./diagnostics.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "docwen-preflight-test-"));
  roots.push(root);
  return root;
}

describe("destination filesystem preflight", () => {
  it.each(["file", "directory"] as const)(
    "probes %s publication without creating missing output parents",
    async (kind) => {
      const root = await fixture();
      const original = path.join(root, "keep.txt");
      await writeFile(original, "original");
      await preflightPublication(path.join(root, "new", "nested", "result"), kind);
      expect(await readdir(root)).toEqual(["keep.txt"]);
      expect(await readFile(original, "utf8")).toBe("original");
    },
  );

  it("preserves an existing overwrite target when the filesystem is unsupported", async () => {
    const root = await fixture();
    const output = path.join(root, "output");
    await mkdir(output);
    await writeFile(path.join(output, "keep.txt"), "original");
    vi.spyOn(publisher, "publishPathNoReplace").mockRejectedValue(
      Object.assign(new Error("unsupported"), { code: "EINVAL" }),
    );
    const failure = await preflightOutputDirectory(output, true).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: "docwen_output_filesystem_unsupported",
      publication: { state: "not_published" },
    });
    expect(diagnosticSummary({ error: failure })).toMatchObject({
      error_category: "unsupported",
      recovery_action: "choose_supported_filesystem",
    });
    expect(await readFile(path.join(output, "keep.txt"), "utf8")).toBe("original");
    expect(await readdir(root)).toEqual(["output"]);
  });

  it("rejects a primitive that does not refuse collisions", async () => {
    const root = await fixture();
    vi.spyOn(publisher, "publishPathNoReplace").mockResolvedValue();
    await expect(preflightPublication(path.join(root, "target"), "file")).rejects.toMatchObject({
      code: "docwen_output_filesystem_unsupported",
    });
    expect(await readdir(root)).toEqual([]);
  });

  it("cancels before probing and leaves no output", async () => {
    const root = await fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(
      preflightPublication(path.join(root, "target"), "file", controller.signal),
    ).rejects.toMatchObject({ code: "docwen_machine_cancelled", publication: { state: "not_published" } });
    expect(await readdir(root)).toEqual([]);
  });
});
