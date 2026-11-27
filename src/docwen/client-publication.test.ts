import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import validReport from "../../contracts/docwen/fixtures/valid/proofread-report.empty.json" with { type: "json" };
import obsoleteReport from "../../contracts/docwen/fixtures/invalid/proofread-report.old-version-field.json" with { type: "json" };
import { executeDocWenTool } from "./client.js";
import { DocWenMachineError, type MachineTaskCompleted } from "./machine-client.js";
import type * as MachineClientModule from "./machine-client.js";
import type * as OutputTransactionModule from "./output-transaction.js";
import * as publisher from "./publish-path.js";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  task: vi.fn(),
  afterPreflight: vi.fn<() => Promise<void>>(),
  hooks: {} as {
    beforeSwap?: () => Promise<void>;
    afterBackupMove?: (backup: string) => Promise<void>;
    cleanupBackup?: (backup: string) => Promise<void>;
  },
}));
vi.mock("./path.js", () => ({ resolveDocWenBinary: async () => process.execPath }));
vi.mock("./machine-client.js", async (original) => ({
  ...(await original<typeof MachineClientModule>()),
  runDocWenMachineQuery: mocks.query,
  runDocWenMachineQueries: async (
    options: Parameters<typeof MachineClientModule.runDocWenMachineQueries>[0],
  ) => {
    const results = [];
    let initialize = {};
    for (const query of options.queries) {
      const response = await mocks.query({ ...options, ...query });
      initialize = response.initialize;
      results.push(response.result);
    }
    return { initialize, results };
  },
  runDocWenMachineTask: async (options: Parameters<typeof MachineClientModule.runDocWenMachineTask>[0]) =>
    mocks.task({
      ...options,
      request:
        typeof options.request === "function"
          ? await options.request(
              async (method, params) => (await mocks.query({ ...options, method, params })).result,
            )
          : options.request,
    }),
}));
vi.mock("./output-transaction.js", async (original) => {
  const actual = await original<typeof OutputTransactionModule>();
  return {
    ...actual,
    preflightOutputDirectory: async (...args: Parameters<typeof actual.preflightOutputDirectory>) => {
      const snapshot = await actual.preflightOutputDirectory(...args);
      await mocks.afterPreflight();
      return snapshot;
    },
    atomicCommitBundle: (...args: Parameters<typeof actual.atomicCommitBundle>) => {
      const [bundle, destination, overwrite, hooks, initial] = args;
      return actual.atomicCommitBundle(bundle, destination, overwrite, { ...hooks, ...mocks.hooks }, initial);
    },
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
  mocks.afterPreflight.mockReset();
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
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function input() {
  const root = await mkdtemp(path.join(tmpdir(), "docwen-tool-publication-"));
  roots.push(root);
  const file = path.join(root, "source.md");
  await writeFile(file, "# Original\n");
  // Windows TEMP can use an 8.3 path even when no junction is under test.
  return realpath(file);
}

describe("reading the completed Markdown validation report", () => {
  function returnReport(verified: Buffer, stored: Buffer = verified, afterWrite?: () => Promise<void>) {
    const originalTask = mocks.task.getMockImplementation()!;
    let staging = "";
    mocks.query.mockResolvedValue({
      result: { capabilities: [{ ...capability, capability_id: "validate.markdown" }] },
    });
    mocks.task.mockImplementationOnce(async (options) => {
      const task: MachineTaskCompleted = await originalTask(options);
      const report = task.bundle.artifacts[0]!;
      report.size_bytes = verified.length;
      report.sha256 = createHash("sha256").update(verified).digest("hex");
      report.media_type = "application/json";
      staging = path.dirname(report.absolutePath);
      await writeFile(report.absolutePath, stored);
      await afterWrite?.();
      return task;
    });
    return () => readdir(staging);
  }

  it.each(["unchanged", "changed", "grew", "cancelled", "expired"] as const)(
    "reads only the verified report and removes staging (%s)",
    async (mode) => {
      const file = await input();
      await writeFile(file, ""); // The pinned report describes an empty Markdown file.
      const controller = new AbortController();
      const verified = Buffer.from(JSON.stringify(validReport));
      const stored =
        mode === "changed"
          ? Buffer.from(verified.toString().replace("note.md", "next.md"))
          : mode === "grew"
            ? Buffer.concat([verified, Buffer.from(" ")])
            : verified;
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const listStaging = returnReport(verified, stored, async () => {
        if (mode === "cancelled") controller.abort();
        if (mode === "expired") await vi.advanceTimersByTimeAsync(1000);
      });
      const result = await executeDocWenTool(
        "docwen_validate_markdown",
        { file },
        { writeTimeoutMs: 1000 },
        controller.signal,
      );
      if (mode === "unchanged") expect(result).toMatchObject({ report: validReport });
      else {
        const code =
          mode === "cancelled"
            ? "docwen_machine_cancelled"
            : mode === "expired"
              ? "docwen_machine_timeout"
              : "docwen_machine_integrity_error";
        expect(result).toMatchObject({ status: "failed", error: { code } });
        expect(result).not.toHaveProperty("report");
      }
      await expect(listStaging()).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(file, "utf8")).toBe("");
    },
  );

  const fullwidthDigit = {
    matched_text: "１",
    error_text: "１",
    suggestion: "1",
    error_type: "symbol",
    source: "symbol",
    rule_key: "symbol_correct",
    range: { start: { offset: 0, line: 0, column: 0 }, end: { offset: 1, line: 0, column: 1 } },
    fix: { kind: "replace_text", replacement: "1", applicable: true },
  };

  it("preserves a valid issue, its range and suggested fix", async () => {
    const file = await input();
    await writeFile(file, "１");
    const report = {
      ...validReport,
      source: { ...validReport.source, content_sha256: createHash("sha256").update("１").digest("hex") },
      issues: [fullwidthDigit],
      summary: { symbol_correct: 1 },
    };
    const listStaging = returnReport(Buffer.from(JSON.stringify(report)));
    expect(await executeDocWenTool("docwen_validate_markdown", { file }, {})).toMatchObject({ report });
    await expect(listStaging()).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    ["JSON scalar", null],
    ["obsolete schema", obsoleteReport],
    ["invalid issue", { ...validReport, issues: [{}] }],
    ["invalid summary", { ...validReport, summary: { typo: -1 } }],
    [
      "invalid nested position",
      {
        ...validReport,
        issues: [
          {
            ...fullwidthDigit,
            range: { ...fullwidthDigit.range, start: { offset: -1, line: 0, column: 0 } },
          },
        ],
      },
    ],
    [
      "fix on a non-fixable issue",
      { ...validReport, issues: [{ ...fullwidthDigit, source: "pairing", rule_key: "symbol_pair" }] },
    ],
  ] as const)("rejects verified bytes that do not contain a v2 report (%s)", async (_name, report) => {
    const file = await input();
    const listStaging = returnReport(Buffer.from(JSON.stringify(report)));
    const result = await executeDocWenTool("docwen_validate_markdown", { file }, {});
    expect(result).toMatchObject({ status: "failed", error: { code: "docwen_validation_report_invalid" } });
    expect(result).not.toHaveProperty("report");
    await expect(listStaging()).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a valid report for different Markdown bytes", async () => {
    const file = await input();
    const listStaging = returnReport(Buffer.from(JSON.stringify(validReport)));
    const result = await executeDocWenTool("docwen_validate_markdown", { file }, {});
    expect(result).toMatchObject({ status: "failed", error: { code: "docwen_machine_integrity_error" } });
    expect(result).not.toHaveProperty("report");
    await expect(listStaging()).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(file, "utf8")).toBe("# Original\n");
  });
});

describe("write tool publication results", () => {
  it.each(["source", "linked resource", "aliased input", "retargeted input"] as const)(
    "rejects an overwrite containing the %s before planning",
    async (mode) => {
      const file = await input();
      const root = path.dirname(file);
      const output = path.join(root, "previous");
      const assets = path.join(output, "assets");
      await mkdir(assets, { recursive: true });
      const asset = path.join(assets, "photo.png");
      await writeFile(asset, "original image");
      const alias = path.join(root, "images");
      if (mode === "aliased input") await symlink(assets, alias, "junction");
      if (mode === "retargeted input") {
        await writeFile(path.join(root, "photo.png"), "outside image");
        await symlink(root, alias, "junction");
        mocks.afterPreflight.mockImplementationOnce(async () => {
          await rename(alias, path.join(root, "old-images"));
          await symlink(assets, alias, "junction");
        });
      }
      const result =
        mode === "source"
          ? await executeDocWenTool(
              "docwen_number_markdown",
              { file, operation: "add", outputDir: root, overwrite: true },
              {},
            )
          : await executeDocWenTool(
              "docwen_convert",
              {
                inputs: [
                  { file, kind: "document", role: "source", logicalPath: "report.md" },
                  {
                    file: mode === "linked resource" ? asset : path.join(alias, "photo.png"),
                    kind: "resource",
                    role: "linked_resource",
                    logicalPath: "assets/photo.png",
                  },
                ],
                to: "docx",
                outputDir: output,
                overwrite: true,
              },
              {},
            );
      expect(result).toMatchObject({
        status: "failed",
        error: { code: "docwen_output_contains_input" },
        publication: { state: "not_published" },
        diagnostic_summary: { recovery_action: "choose_new_output_directory" },
      });
      expect(mocks.query).not.toHaveBeenCalled();
      expect(await readFile(file, "utf8")).toBe("# Original\n");
      expect(await readFile(asset, "utf8")).toBe("original image");
    },
  );

  it.each(["stable", "retargeted"] as const)(
    "binds in-place numbering to the prepared input through a %s directory alias",
    async (mode) => {
      const root = path.dirname(await input());
      const original = path.join(root, "first");
      const unrelated = path.join(root, "second");
      const alias = path.join(root, "active");
      const relative = path.join("notes", "copy.md");
      for (const folder of [original, unrelated]) {
        await mkdir(path.join(folder, "notes"), { recursive: true });
        await writeFile(path.join(folder, relative), "# Identical text\n");
      }
      await symlink(original, alias, "junction");
      const originalFile = await realpath(path.join(original, relative));
      const task = mocks.task.getMockImplementation()!;
      mocks.task.mockImplementationOnce(async (options) => {
        expect(options.request.inputs[0].locator.path).toBe(originalFile);
        if (mode === "retargeted") {
          await rm(alias);
          await symlink(unrelated, alias, "junction");
        }
        return task(options);
      });
      const result = await executeDocWenTool(
        "docwen_number_markdown",
        { file: path.join(alias, relative), operation: "add", inPlace: true },
        {},
      );
      if (mode === "retargeted") {
        expect(result).toMatchObject({
          status: "failed",
          error: { code: "docwen_source_changed" },
          publication: { state: "not_published" },
        });
        expect(await readFile(originalFile, "utf8")).toBe("# Identical text\n");
      } else {
        expect(result).toMatchObject({ status: "success", output: { preferred_artifact: originalFile } });
        expect(await readFile(originalFile, "utf8")).toBe("# 1. Result\n");
      }
      expect(await readFile(path.join(unrelated, relative), "utf8")).toBe("# Identical text\n");
    },
  );

  it.each([false, true])(
    "checks output filesystem before starting conversion (inPlace=%s)",
    async (inPlace) => {
      const file = await input();
      vi.spyOn(publisher, "publishPathNoReplace").mockRejectedValue(
        Object.assign(new Error("unsupported"), { code: "EINVAL" }),
      );
      const result = await executeDocWenTool(
        "docwen_number_markdown",
        {
          file,
          operation: "add",
          ...(inPlace ? { inPlace: true } : { outputDir: path.join(path.dirname(file), "result") }),
        },
        {},
      );
      expect(result).toMatchObject({
        diagnostic_summary: { error_category: "unsupported", recovery_action: "choose_supported_filesystem" },
      });
      expect(mocks.task).not.toHaveBeenCalled();
      expect(await readFile(file, "utf8")).toBe("# Original\n");
      expect(await readdir(path.dirname(file))).toEqual(["source.md"]);
    },
  );

  it("sends public PDF split inputs as resources before task planning", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "docwen-pdf-split-kind-"));
    roots.push(root);
    const file = path.join(root, "source.pdf");
    const outputDir = path.join(root, "split-output");
    await writeFile(file, Buffer.from("%PDF-1.4\n"));

    const splitCapability = {
      capability_id: "split.pdf.partition",
      operation: "transform",
      input_shape: {
        slots: [
          {
            role: "source",
            kind: "resource",
            media_types: ["application/pdf"],
            min_items: 1,
            max_items: 1,
          },
        ],
        undeclared_roles: "reject",
      },
      output_media_types: ["application/pdf"],
      output_shape: {
        cardinality: "many",
        artifact_kinds: ["document"],
        relation_types: [],
        atomic_bundle: true,
      },
      options_schema: {},
      availability: "available",
      dependencies: [],
      limitations: [],
    };
    mocks.query.mockResolvedValue({ initialize: {}, result: { capabilities: [splitCapability] } });
    let plannedKind: unknown;
    mocks.task.mockImplementationOnce(async ({ request }) => {
      plannedKind = request.inputs[0]?.kind;
      throw new DocWenMachineError("probe_stop", "planned");
    });

    const result = await executeDocWenTool("docwen_split_pdf", { file, pages: "1", outputDir }, {});

    expect(plannedKind).toBe("resource");
    expect(result).toMatchObject({ status: "failed", error: { code: "probe_stop" } });
    await expect(readdir(outputDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("honors cancellation immediately before commit and releases the transaction", async () => {
    const file = await input();
    const controller = new AbortController();
    mocks.hooks.beforeSwap = async () => {
      controller.abort();
    };
    const result = await executeDocWenTool(
      "docwen_number_markdown",
      { file, operation: "add", inPlace: true },
      {},
      controller.signal,
    );
    expect(result).toMatchObject({ status: "failed", publication: { state: "not_published" } });
    expect(await readFile(file, "utf8")).toBe("# Original\n");
    expect(await readdir(path.dirname(file))).toEqual(["source.md"]);
    expect(mocks.task).toHaveBeenCalledTimes(1);
    mocks.hooks = {};
    mocks.afterPreflight.mockReset();
    expect(
      await executeDocWenTool("docwen_number_markdown", { file, operation: "add", inPlace: true }, {}),
    ).toMatchObject({ status: "success" });
  });

  it("finishes one publication when cancellation arrives after the backup move", async () => {
    const file = await input();
    const controller = new AbortController();
    mocks.hooks.afterBackupMove = async () => {
      controller.abort();
    };
    const result = await executeDocWenTool(
      "docwen_number_markdown",
      { file, operation: "add", inPlace: true },
      {},
      controller.signal,
    );
    expect(controller.signal.aborted).toBe(true);
    expect(result).toMatchObject({
      status: "success",
      publication: { state: "published", retry: "do_not_retry" },
    });
    expect(await readFile(file, "utf8")).toBe("# 1. Result\n");
    expect(await readdir(path.dirname(file))).toEqual(["source.md"]);
    expect(mocks.task).toHaveBeenCalledTimes(1);
  });

  it.each(["beforeSwap", "afterBackupMove"] as const)(
    "retains the publication boundary when the overall deadline expires at %s",
    async (phase) => {
      const file = await input();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        mocks.hooks[phase] = async () => {
          await vi.advanceTimersByTimeAsync(1000);
        };
        const result = await executeDocWenTool(
          "docwen_number_markdown",
          { file, operation: "add", inPlace: true },
          { writeTimeoutMs: 1000 },
        );
        expect(result).toMatchObject(
          phase === "beforeSwap"
            ? {
                status: "failed",
                error: { code: "docwen_machine_timeout" },
                publication: { state: "not_published" },
              }
            : { status: "success", publication: { state: "published", retry: "do_not_retry" } },
        );
        expect(await readFile(file, "utf8")).toBe(phase === "beforeSwap" ? "# Original\n" : "# 1. Result\n");
        expect(await readdir(path.dirname(file))).toEqual(["source.md"]);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("preserves a concurrent source edit made after the backup move", async () => {
    const file = await input();
    mocks.hooks.afterBackupMove = async (backup) => {
      await writeFile(backup, "# Concurrent edit\n");
    };
    const result = await executeDocWenTool(
      "docwen_number_markdown",
      { file, operation: "add", inPlace: true },
      {},
    );
    expect(result).toMatchObject({ status: "failed", publication: { state: "not_published" } });
    expect(await readFile(file, "utf8")).toBe("# Concurrent edit\n");
    expect(await readdir(path.dirname(file))).toEqual(["source.md"]);
    expect(mocks.task).toHaveBeenCalledTimes(1);
  });

  it("preserves a destination created by another writer at the final directory commit", async () => {
    const file = await input();
    const outputDir = path.join(path.dirname(file), "result");
    mocks.hooks.beforeSwap = async () => {
      await mkdir(outputDir);
      await writeFile(path.join(outputDir, "other.txt"), "other writer");
    };
    const result = await executeDocWenTool(
      "docwen_number_markdown",
      { file, operation: "add", outputDir },
      {},
    );
    expect(result).toMatchObject({ status: "failed", publication: { state: "not_published" } });
    expect(await readFile(path.join(outputDir, "other.txt"), "utf8")).toBe("other writer");
    expect(await readdir(outputDir)).toEqual(["other.txt"]);
    expect((await readdir(path.dirname(file))).sort()).toEqual(["result", "source.md"]);
    expect(mocks.task).toHaveBeenCalledTimes(1);
  });
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

describe("request locale propagation", () => {
  it.each([true, false])(
    "passes Arabic only when the selected capability accepts locale (%s)",
    async (supportsLocale) => {
      const root = await mkdtemp(path.join(tmpdir(), "docwen-arabic-"));
      roots.push(root);
      const source = path.join(root, "عربي.md");
      await writeFile(source, "# مرحبا");
      mocks.query.mockResolvedValue({
        initialize: {},
        result: {
          capabilities: [
            {
              ...capability,
              capability_id: "validate.markdown",
              options_schema: {
                properties: supportsLocale ? { locale: { type: "string", enum: ["ar_SA"] } } : {},
              },
            },
          ],
        },
      });
      mocks.task.mockImplementation(async ({ request }) => {
        expect(request.options.locale).toBe(supportsLocale ? "ar_SA" : undefined);
        throw new Error("captured Arabic plan");
      });
      await executeDocWenTool("docwen_validate_markdown", { file: source }, { language: "ar_SA" });
      expect(mocks.task).toHaveBeenCalledOnce();
    },
  );
});
