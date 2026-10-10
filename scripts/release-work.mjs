import { spawnSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve, win32, posix } from "node:path";
import process from "node:process";

const OWNER = "docwen.openclaw.release";
const MARKER = ".docwen-temp-lease.json";

function plainPath(path) {
  let current = resolve(path);
  while (true) {
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error("release_work_link_forbidden");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function processIdentity() {
  if (process.platform !== "win32") return undefined;
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `[System.Diagnostics.Process]::GetProcessById(${process.pid}).StartTime.ToUniversalTime().ToFileTimeUtc().ToString('x16')`,
    ],
    { encoding: "utf8", timeout: 10000, windowsHide: true, shell: false },
  );
  const identity = result.stdout?.trim();
  if (result.status !== 0 || !/^[0-9a-f]{16}$/u.test(identity ?? "")) {
    throw new Error("release_work_process_identity_unavailable");
  }
  return `windows-filetime:${identity}`;
}

function governedParent(repo) {
  const engineeringRoot = dirname(dirname(repo));
  const workspace = join(engineeringRoot, ".workspace");
  const registry = join(workspace, "workspace.json");
  plainPath(registry);
  if (!lstatSync(workspace).isDirectory() || !lstatSync(registry).isFile()) {
    throw new Error("release_work_workspace_missing");
  }
  const record = JSON.parse(readFileSync(registry, "utf8"));
  if (
    record?.schema !== "docwen.workspace.v1" ||
    !Array.isArray(record.repositories) ||
    record.repositories.length === 0
  ) {
    throw new Error("release_work_registry_invalid");
  }
  const canonical = (value) => (process.platform === "win32" ? value.toLowerCase() : value);
  const registered = new Set();
  for (const entry of record.repositories) {
    if (
      typeof entry !== "string" ||
      win32.isAbsolute(entry) ||
      posix.isAbsolute(entry) ||
      entry.includes("\\") ||
      entry.includes(":") ||
      entry.split("/").some((part) => !part || part === "." || part === "..") ||
      entry.split("/")[0].toLowerCase() === ".workspace"
    ) {
      throw new Error("release_work_registered_path_invalid");
    }
    const target = resolve(engineeringRoot, entry);
    plainPath(target);
    if (registered.has(canonical(target))) throw new Error("release_work_duplicate_repository");
    registered.add(canonical(target));
  }
  if (!registered.has(canonical(repo))) throw new Error("release_work_repository_not_registered");
  const parent = join(workspace, "temp");
  plainPath(parent);
  if (!lstatSync(parent).isDirectory()) throw new Error("release_work_workspace_missing");
  return parent;
}

export function createReleaseWork(repoRoot) {
  const repo = resolve(repoRoot);
  plainPath(repo);
  if (!lstatSync(repo).isDirectory()) throw new Error("release_work_repository_missing");
  let parent = join(repo, "build");
  if (basename(dirname(repo)).toLowerCase() === "repos") {
    let hasWorkspace = false;
    try {
      lstatSync(join(dirname(dirname(repo)), ".workspace"));
      hasWorkspace = true;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (hasWorkspace) parent = governedParent(repo);
  }
  plainPath(parent);
  mkdirSync(parent, { recursive: true });
  const identity = processIdentity();
  const root = realpathSync.native(mkdtempSync(join(parent, "oc-release-")));
  const lease = {
    schemaVersion: 1,
    owner: OWNER,
    kind: "openclaw-release-work",
    root,
    pid: process.pid,
    ...(identity ? { processIdentity: identity } : {}),
    state: "active",
    createdAt: new Date().toISOString(),
  };
  writeFileSync(join(root, MARKER), `${JSON.stringify(lease, null, 2)}\n`, { flag: "wx" });
  return { root, lease };
}

export function finishReleaseWork(work, success) {
  plainPath(join(work.root, MARKER));
  const actual = JSON.parse(readFileSync(join(work.root, MARKER), "utf8"));
  if (
    realpathSync.native(work.root) !== work.root ||
    actual.owner !== OWNER ||
    actual.root !== work.root ||
    actual.pid !== process.pid ||
    actual.createdAt !== work.lease.createdAt ||
    actual.processIdentity !== work.lease.processIdentity
  ) {
    throw new Error("release_work_owner_changed");
  }
  const save = (state) =>
    writeFileSync(
      join(work.root, MARKER),
      `${JSON.stringify({ ...actual, state, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    );
  save(success ? "completed-success" : "retained-failure");
  if (success) {
    try {
      rmSync(work.root, { recursive: true });
    } catch (error) {
      try {
        save("retained-cleanup-failure");
      } catch {
        /* Keep the original cleanup error. */
      }
      throw error;
    }
  }
}
