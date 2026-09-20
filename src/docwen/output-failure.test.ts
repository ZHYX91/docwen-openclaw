import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { atomicReplaceFile } from "./output-transaction.js";
import type * as PublishPathModule from "./publish-path.js";
import type * as OutputLockModule from "./output-lock.js";

const injected = vi.hoisted(() => ({ mode: "probe" as "probe" | "commit" | "lost_lock", calls: 0 }));
vi.mock("./output-lock.js", async (original) => {
  const actual = await original<typeof OutputLockModule>();
  return {
    ...actual,
    acquireOutputLock: async (destination: string) => {
      const lock = await actual.acquireOutputLock(destination);
      let checks = 0;
      return {
        ...lock,
        assertHeld: () => {
          checks++;
          if (injected.mode === "lost_lock" && checks === 3)
            throw Object.assign(new Error("output lock lost"), { code: "ELOCKLOST" });
          lock.assertHeld();
        },
      };
    },
  };
});
vi.mock("./publish-path.js", async (original) => {
  const actual = await original<typeof PublishPathModule>();
  return {
    ...actual,
    publishPathNoReplace: async (...args: Parameters<typeof actual.publishPathNoReplace>) => {
      injected.calls++;
      if (injected.mode === "probe")
        throw Object.assign(new Error("unsupported filesystem"), { code: "ENOTSUP" });
      await actual.publishPathNoReplace(...args);
      if (injected.mode === "commit" && injected.calls === 2)
        throw Object.assign(new Error("publication acknowledgement lost"), { code: "EIO" });
    },
  };
});
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function input() {
  injected.calls = 0;
  const root = await mkdtemp(path.join(tmpdir(), "docwen-output-failure-"));
  roots.push(root);
  const destination = path.join(root, "source.md"),
    replacement = path.join(root, "replacement.md");
  await writeFile(destination, "original");
  await writeFile(replacement, "new");
  return {
    root,
    destination,
    replacement,
    expected: { sizeBytes: 3, sha256: createHash("sha256").update("new").digest("hex") },
  };
}
describe("uncertain filesystem results", () => {
  it("restores the original if the lock is lost before final publication", async () => {
    injected.mode = "lost_lock";
    const value = await input();
    await expect(
      atomicReplaceFile(value.destination, value.replacement, value.expected),
    ).rejects.toMatchObject({ publication: { state: "not_published" } });
    expect(await readFile(value.destination, "utf8")).toBe("original");
    expect(await readdir(value.root)).toEqual(["replacement.md", "source.md"]);
  });
  it("rejects unsupported filesystems before moving the original", async () => {
    injected.mode = "probe";
    const value = await input();
    await expect(
      atomicReplaceFile(value.destination, value.replacement, value.expected),
    ).rejects.toMatchObject({ publication: { state: "not_published" } });
    expect(await readFile(value.destination, "utf8")).toBe("original");
    expect(await readdir(value.root)).toEqual(["replacement.md", "source.md"]);
    expect(injected.calls).toBe(1);
  });
  it("keeps the output and recovery material when a completed publication loses acknowledgement", async () => {
    injected.mode = "commit";
    const value = await input();
    const failure = await atomicReplaceFile(value.destination, value.replacement, value.expected).catch(
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({ publication: { state: "unconfirmed", retry: "do_not_retry" } });
    const backup = (failure as { publication: { recovery: { backup: string } } }).publication.recovery.backup;
    expect(await readFile(backup, "utf8")).toBe("original");
    expect(await readFile(value.destination, "utf8")).toBe("new");
    expect(injected.calls).toBe(2);
  });
});
