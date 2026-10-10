import { existsSync, readFileSync, realpathSync, writeFileSync, symlinkSync } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
  async function governed(record = { schema: "docwen.workspace.v1", repositories: ["repos/plugin"] }) {
    const root = await repository();
    const repo = join(root, "repos", "plugin");
    const workspace = join(root, ".workspace");
    await mkdir(repo, { recursive: true });
    await mkdir(join(workspace, "temp"), { recursive: true });
    writeFileSync(join(workspace, "workspace.json"), JSON.stringify(record));
    return { repo, workspace };
  }

  it("uses registered workspace identity without depending on README prose", async () => {
    const { repo, workspace } = await governed();
    writeFileSync(join(workspace, "README.md"), "# Shared engineering runtime\n");
    const work = createReleaseWork(repo);
    expect(dirname(work.root)).toBe(realpathSync.native(join(workspace, "temp")));
    expect(existsSync(join(repo, "build"))).toBe(false);
    finishReleaseWork(work, true);
    expect(existsSync(work.root)).toBe(false);
  });

  it.each([
    [{ schema: "other", repositories: ["repos/plugin"] }, "release_work_registry_invalid"],
    [
      { schema: "docwen.workspace.v1", repositories: ["repos/another"] },
      "release_work_repository_not_registered",
    ],
    [{ schema: "docwen.workspace.v1", repositories: ["../escape"] }, "release_work_registered_path_invalid"],
    [{ schema: "docwen.workspace.v1", repositories: ["C:/escape"] }, "release_work_registered_path_invalid"],
    [
      { schema: "docwen.workspace.v1", repositories: [".workspace/temp"] },
      "release_work_registered_path_invalid",
    ],
    [
      { schema: "docwen.workspace.v1", repositories: ["repos/plugin", "repos/plugin"] },
      "release_work_duplicate_repository",
    ],
  ])("refuses invalid or unrelated registration %#", async (record, error) => {
    const { repo } = await governed(record);
    expect(() => createReleaseWork(repo)).toThrow(error);
    expect(existsSync(join(repo, "build"))).toBe(false);
  });

  it("refuses a linked runtime before creating owned work", async () => {
    const { repo, workspace } = await governed();
    await rm(join(workspace, "temp"), { recursive: true });
    const outside = await repository();
    symlinkSync(outside, join(workspace, "temp"), process.platform === "win32" ? "junction" : "dir");
    expect(() => createReleaseWork(repo)).toThrow("release_work_link_forbidden");
  });

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

  it("supports an independent clone below a directory merely named repos", async () => {
    const repo = await repository();
    const governed = join(repo, "repos", "plugin");
    await mkdir(governed, { recursive: true });
    const work = createReleaseWork(governed);
    expect(dirname(work.root)).toBe(realpathSync.native(join(governed, "build")));
    finishReleaseWork(work, true);
    expect(existsSync(join(repo, ".workspace"))).toBe(false);
  });

  it("refuses an existing workspace without its registry instead of falling back", async () => {
    const { repo, workspace } = await governed();
    await rm(join(workspace, "workspace.json"));
    expect(() => createReleaseWork(repo)).toThrow();
    expect(existsSync(join(repo, "build"))).toBe(false);
  });

  it("refuses a dangling workspace link instead of treating it as absent", async () => {
    const root = await repository();
    const repo = join(root, "repos", "plugin");
    await mkdir(repo, { recursive: true });
    symlinkSync(
      join(root, "missing"),
      join(root, ".workspace"),
      process.platform === "win32" ? "junction" : "dir",
    );
    expect(() => createReleaseWork(repo)).toThrow("release_work_link_forbidden");
    expect(existsSync(join(repo, "build"))).toBe(false);
  });
});
