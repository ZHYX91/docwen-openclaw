import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeDocWenTool } from "./client.js";
import { DocWenMachineError, type MachineTaskCompleted } from "./machine-client.js";
import type * as MachineClientModule from "./machine-client.js";
import type * as OutputTransactionModule from "./output-transaction.js";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  task: vi.fn(),
  hooks: {} as {
    afterBackupMove?: (backup: string) => Promise<void>;
    cleanupBackup?: (backup: string) => Promise<void>;
  },
}));
vi.mock("./path.js", () => ({ resolveDocWenBinary: async () => process.execPath }));
vi.mock("./machine-client.js", async (original) => ({
  ...(await original<typeof MachineClientModule>()),
  runDocWenMachineQuery: mocks.query,
  runDocWenMachineTask: mocks.task,
}));
vi.mock("./output-transaction.js", async (original) => {
  const actual = await original<typeof OutputTransactionModule>();
  return {
    ...actual,
    atomicReplaceFile: (...args: Parameters<typeof actual.atomicReplaceFile>) => {
      const [destination, replacement, expected, hooks, sourceVersion] = args;
      return actual.atomicReplaceFile(
        destination,
        replacement,
        expected,
        { ...hooks, ...mocks.hooks },
        sourceVersion,
      );
    },
  };
});

const roots: string[] = [];
const capability = {
  capability_id: "transform.markdown.heading_numbering",
  operation: "transform",
  input_shape: {
    slots: [{ role: "source", kind: "document", media_types: ["text/markdown"], min_items: 1, max_items: 1 }],
    undeclared_roles: "reject",
  },
  output_media_types: ["text/markdown"],
  output_shape: { cardinality: "one", artifact_kinds: ["document"], relation_types: [], atomic_bundle: true },
  options_schema: {},
  availability: "available",
  dependencies: [],
  limitations: [],
};
beforeEach(() => {
  mocks.hooks = {};
  mocks.query.mockReset().mockResolvedValue({ initialize: {}, result: { capabilities: [capability] } });
  mocks.task.mockReset().mockImplementation(async ({ request }): Promise<MachineTaskCompleted> => {
    const file = path.join(request.output.staging_root.path, "result.md");
    const bytes = Buffer.from("# 1. Result\n");
    await writeFile(file, bytes);
    return {
      taskId: "task.number",
      plan: { capability_id: capability.capability_id },
      diagnostics: [],
      metrics: {},
      progress: [],
      bundle: {
        schema: "docwen.artifact_bundle.v3",
        bundle_id: "bundle.number",
        task_id: "task.number",
        producer: { name: "DocWen", product_version: "0.12.0", machine_protocol: "docwen.machine.v2" },
        layout_schema: "docwen.artifact_layout.v1",
        artifacts: [
          {
            artifact_id: "document.number",
            kind: "document",
            locator: "result.md",
            logical_path: "result.md",
            suggested_name: "result.md",
            media_type: "text/markdown",
            size_bytes: bytes.length,
            sha256: createHash("sha256").update(bytes).digest("hex"),
            absolutePath: file,
          },
        ],
        entries: [{ artifact_id: "document.number", role: "primary", ordinal: 0, preferred: true }],
        relations: [],
      },
    };
  });
});
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function input() {
  const root = await mkdtemp(path.join(tmpdir(), "docwen-tool-publication-"));
  roots.push(root);
  const file = path.join(root, "source.md");
  await writeFile(file, "# Original\n");
  return file;
}

describe("write tool publication results", () => {
  it("returns a shareable read-failure summary without inventing a write or invoking a task", async () => {
    const secret = "private-path-and-token";
    mocks.query.mockRejectedValue(
      new DocWenMachineError(`docwen_machine_remote:${secret}`, secret, {
        category: "dependency",
        retryable: true,
        details: { path: secret, command: secret },
      }),
    );
    const result = await executeDocWenTool("docwen_info", {}, {});
    expect(result).toMatchObject({
      status: "failed",
      diagnostic_summary: {
        publication_state: "not_applicable",
        error_category: "dependency",
        error_code: "remote_error",
        recovery_action: "check_dependencies",
        reported_retryable: true,
      },
    });
    expect(result).not.toHaveProperty("publication");
    expect(JSON.stringify((result as { diagnostic_summary: unknown }).diagnostic_summary)).not.toContain(
      secret,
    );
    expect(mocks.task).not.toHaveBeenCalled();
  });

  it("returns a usable published result and a cleanup warning without a second write", async () => {
    const file = await input();
    mocks.hooks.cleanupBackup = async () => {
      throw new Error("backup is busy");
    };
    const result = await executeDocWenTool(
      "docwen_number_markdown",
      { file, operation: "add", inPlace: true },
      {},
    );
    expect(result).toMatchObject({
      status: "warning",
      publication: {
        state: "published",
        retry: "do_not_retry",
        warnings: [{ code: "backup_cleanup_failed" }],
      },
      output: { preferred_artifact: file },
      diagnostic_summary: {
        outcome: "warning",
        publication_state: "published",
        retry: "do_not_retry",
        recovery_action: "review_cleanup_keep_outputs",
        output_count: 1,
      },
    });
    expect(await readFile(file, "utf8")).toBe("# 1. Result\n");
    expect(mocks.task).toHaveBeenCalledTimes(1);
    expect(JSON.stringify((result as { diagnostic_summary: unknown }).diagnostic_summary)).not.toContain(
      file,
    );
  });

  it("does not report a success when a read rejects without an Error object", async () => {
    mocks.query.mockRejectedValue(undefined);
    expect(await executeDocWenTool("docwen_info", {}, {})).toMatchObject({
      status: "failed",
      diagnostic_summary: { outcome: "failed", error_category: "unknown" },
    });
  });

  it("returns unconfirmed recovery paths without claiming an intervening file as its output", async () => {
    const file = await input();
    mocks.hooks.afterBackupMove = async () => {
      await writeFile(file, "intervening writer", { flag: "wx" });
    };
    const result = await executeDocWenTool(
      "docwen_number_markdown",
      { file, operation: "add", inPlace: true },
      {},
    );
    expect(result).toMatchObject({
      status: "unconfirmed",
      publication: { state: "unconfirmed", retry: "do_not_retry", recovery: { destination: file } },
      diagnostic_summary: {
        outcome: "unconfirmed",
        recovery_action: "review_recovery_paths",
        retry: "do_not_retry",
      },
    });
    expect(result).not.toHaveProperty("output");
    expect(await readFile(file, "utf8")).toBe("intervening writer");
    expect(mocks.task).toHaveBeenCalledTimes(1);
  });
  it("returns usable paths and the complete in-memory Bundle after one publication", async () => {
    const file = await input();
    const result = await executeDocWenTool(
      "docwen_number_markdown",
      { file, operation: "add", inPlace: true },
      {},
    );
    expect(result).toMatchObject({
      status: "success",
      publication: { state: "published", retry: "do_not_retry", warnings: [] },
      output: { preferred_artifact: file, artifacts: [file], in_place: true },
      bundle: { artifacts: [{ logical_path: "result.md" }], relations: [] },
    });
    expect(await readFile(file, "utf8")).toBe("# 1. Result\n");
    expect((result as { bundle: { artifacts: unknown[] } }).bundle.artifacts[0]).not.toHaveProperty(
      "absolutePath",
    );
    expect(mocks.task).toHaveBeenCalledTimes(1);
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });

  it("does not trust a producer's claimed publication state or retry the task", async () => {
    const file = await input();
    mocks.task.mockRejectedValue(
      new DocWenMachineError("producer_failure", "Task failed", { publication: { state: "published" } }),
    );
    const result = await executeDocWenTool(
      "docwen_number_markdown",
      { file, operation: "add", inPlace: true },
      {},
    );
    expect(result).toMatchObject({
      status: "failed",
      publication: { state: "not_published", retry: "review_before_retry" },
      error: { code: "producer_failure" },
      diagnostic_summary: { error_code: "unknown", publication_state: "not_published" },
    });
    expect(result).not.toHaveProperty("output");
    expect(await readFile(file, "utf8")).toBe("# Original\n");
    expect(mocks.task).toHaveBeenCalledTimes(1);
  });

  it("reports invalid write parameters as a known non-publication", async () => {
    const result = await executeDocWenTool(
      "docwen_number_markdown",
      { file: await input(), operation: "add" },
      {},
    );
    expect(result).toMatchObject({
      status: "failed",
      publication: { state: "not_published" },
      error: { code: "docwen_number_requires_one_output_mode" },
    });
    expect(mocks.task).not.toHaveBeenCalled();
  });
});
