import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it } from "vitest";

import { createReleaseWork, finishReleaseWork } from "./release-work.mjs";

const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true });
});

async function repository() {
  const root = await mkdtemp(join(tmpdir(), "oc-work-test-"));
  roots.push(root);
  const repo = join(root, "repo");
  await mkdir(repo);
  return repo;
}

describe("release work ownership", () => {
  it("owns a unique run and removes its successful build", async () => {
    const repo = await repository();
    const work = createReleaseWork(repo);
    const sentinel = join(repo, "keep.txt");
    writeFileSync(sentinel, "original");
    writeFileSync(join(work.root, "build.txt"), "temporary");
    expect(work.lease.state).toBe("active");
    expect(work.lease.pid).toBe(process.pid);
    if (process.platform === "win32")
      expect(work.lease.processIdentity).toMatch(/^windows-filetime:[0-9a-f]{16}$/u);
    finishReleaseWork(work, true);
    expect(existsSync(work.root)).toBe(false);
    expect(readFileSync(sentinel, "utf8")).toBe("original");
  });

  it("retains failed work with a bounded-retention lease", async () => {
    const work = createReleaseWork(await repository());
    finishReleaseWork(work, false);
    const lease = JSON.parse(readFileSync(join(work.root, ".docwen-temp-lease.json"), "utf8"));
    expect(lease.state).toBe("retained-failure");
    expect(lease.owner).toBe("docwen.openclaw.release");
    expect(lease.root).toBe(work.root);
  });

  it("does not remove work whose ownership record changed", async () => {
    const work = createReleaseWork(await repository());
    const marker = join(work.root, ".docwen-temp-lease.json");
    writeFileSync(marker, JSON.stringify({ ...work.lease, pid: process.pid + 1 }));
    expect(() => finishReleaseWork(work, true)).toThrow("release_work_owner_changed");
    expect(existsSync(work.root)).toBe(true);
  });

  it("does not invent a missing governed workspace", async () => {
    const repo = await repository();
    const governed = join(repo, "repos", "plugin");
    await mkdir(governed, { recursive: true });
    expect(() => createReleaseWork(governed)).toThrow();
    expect(existsSync(join(repo, ".workspace"))).toBe(false);
    expect(existsSync(join(governed, "build"))).toBe(false);
  });
});
