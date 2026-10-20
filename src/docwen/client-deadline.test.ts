import { getEventListeners } from "node:events";
import type * as FileSystem from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as MachineClient from "./machine-client.js";

const state = vi.hoisted(() => ({
  heldPath: "",
  stream: null as PassThrough | null,
  started: () => {},
  reads: [] as string[],
  query: vi.fn(),
  task: vi.fn(),
}));

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof FileSystem>();
  return {
    ...actual,
    createReadStream(...args: Parameters<typeof actual.createReadStream>) {
      state.reads.push(String(args[0]));
      if (args[0] === state.heldPath && state.stream) {
        state.started();
        return state.stream;
      }
      return actual.createReadStream(...args);
    },
  };
});
vi.mock("./machine-client.js", async (original) => ({
  ...(await original<typeof MachineClient>()),
  runDocWenMachineQuery: state.query,
  runDocWenMachineTask: state.task,
}));

import { executeDocWenTool } from "./client.js";

const roots: string[] = [];
const controllers: AbortController[] = [];
const originalText = "# Original\n";

beforeEach(() => {
  state.heldPath = "";
  state.stream = null;
  state.started = () => {};
  state.reads = [];
  state.query.mockReset().mockResolvedValue({ initialize: {}, result: { inspected: true } });
  state.task.mockReset();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(async () => {
  for (const controller of controllers.splice(0)) controller.abort();
  state.stream?.destroy();
  vi.useRealTimers();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function input() {
  // Input hashing uses realpath; match it even when TEMP uses a Windows short path or a symlink.
  const root = await realpath(await mkdtemp(join(tmpdir(), "docwen-input-deadline-")));
  roots.push(root);
  const file = join(root, "source.md");
  const binaryPath = join(root, process.platform === "win32" ? "DocWenCLI.exe" : "DocWenCLI");
  await writeFile(file, originalText);
  await writeFile(binaryPath, "This executable must not be started by the preparation tests.\n");
  await chmod(binaryPath, 0o700);
  const controller = new AbortController();
  controllers.push(controller);
  return { root, file, controller, config: { binaryPath, readTimeoutMs: 1000, writeTimeoutMs: 1000 } };
}

function hold(file: string) {
  const stream = new PassThrough();
  state.heldPath = file;
  state.stream = stream;
  const started = new Promise<void>((resolve) => {
    state.started = resolve;
  });
  return { stream, started };
}

describe("public tool preparation and operation deadlines", () => {
  it.each(["inspect", "validate", "in_place", "convert"])(
    "cancels a stalled input fingerprint without waiting for EOF: %s",
    async (mode) => {
      const { root, file, controller, config } = await input();
      const stalled = hold(file);
      const tool =
        mode === "inspect"
          ? "docwen_inspect"
          : mode === "validate"
            ? "docwen_validate_markdown"
            : mode === "in_place"
              ? "docwen_number_markdown"
              : "docwen_convert";
      const params =
        mode === "in_place"
          ? { file, operation: "add", inPlace: true }
          : mode === "convert"
            ? {
                inputs: [{ file, kind: "document", role: "source", logicalPath: "source.md" }],
                to: "docx",
                outputDir: join(root, "output"),
              }
            : { file };
      const operation = executeDocWenTool(tool, params, config, controller.signal);
      await stalled.started;
      stalled.stream.write("# ");
      controller.abort();

      expect(await operation).toMatchObject({
        status: "failed",
        error: { code: "docwen_machine_cancelled" },
        diagnostic_summary: { error_category: "cancelled" },
      });
      expect(stalled.stream.destroyed).toBe(true);
      expect(state.query).not.toHaveBeenCalled();
      expect(state.task).not.toHaveBeenCalled();
      expect(await readFile(file, "utf8")).toBe(originalText);
      expect(await readdir(root)).toEqual(expect.arrayContaining(["source.md"]));
      expect(await readdir(root)).not.toContain("output");
      expect(vi.getTimerCount()).toBe(0);
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    },
  );

  it("times out preparation before reading later inputs or starting a Machine task", async () => {
    const { root, file, controller, config } = await input();
    const next = join(root, "next.md");
    await writeFile(next, "# Next\n");
    const stalled = hold(file);
    const operation = executeDocWenTool(
      "docwen_convert",
      {
        inputs: [file, next].map((item, index) => ({
          file: item,
          kind: "document",
          role: "source",
          logicalPath: `${index}.md`,
        })),
        to: "docx",
        outputDir: join(root, "output"),
      },
      config,
      controller.signal,
    );
    await stalled.started;
    stalled.stream.write("# ");
    await vi.advanceTimersByTimeAsync(1000);

    expect(await operation).toMatchObject({
      status: "failed",
      error: { code: "docwen_machine_timeout" },
      publication: { state: "not_published" },
      diagnostic_summary: { error_category: "timeout", timeout_ms: 1000 },
    });
    expect(stalled.stream.destroyed).toBe(true);
    expect(state.reads).toEqual([file]);
    expect(state.task).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it.each(["docwen_inspect", "docwen_validate_markdown"])(
    "keeps the preparation time inside the same budget after Machine handoff: %s",
    async (tool) => {
      const { file, controller, config } = await input();
      config.writeTimeoutMs = 2000;
      const timeoutMs = tool === "docwen_inspect" ? config.readTimeoutMs : config.writeTimeoutMs;
      const stalled = hold(file);
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const machine = tool === "docwen_inspect" ? state.query : state.task;
      machine.mockImplementationOnce(({ signal }: { signal: AbortSignal }) => {
        entered();
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      });
      let settled = false;
      const operation = executeDocWenTool(tool, { file }, config, controller.signal).finally(() => {
        settled = true;
      });
      await stalled.started;
      await vi.advanceTimersByTimeAsync(timeoutMs - 400);
      stalled.stream.end(originalText);
      await started;
      await vi.advanceTimersByTimeAsync(399);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      expect(await operation).toMatchObject({
        status: "failed",
        error: { code: "docwen_machine_timeout" },
        diagnostic_summary: { timeout_ms: timeoutMs },
      });
      expect(machine).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("applies the deadline while fingerprinting an existing output before conversion", async () => {
    const { root, file, config } = await input();
    const outputDir = join(root, "output");
    await mkdir(outputDir);
    const previous = join(outputDir, "previous.md");
    await writeFile(previous, originalText);
    const stalled = hold(previous);
    const operation = executeDocWenTool(
      "docwen_number_markdown",
      { file, operation: "add", outputDir, overwrite: true },
      config,
    );
    await stalled.started;
    await vi.advanceTimersByTimeAsync(1000);
    expect(await operation).toMatchObject({
      status: "failed",
      error: { code: "docwen_machine_timeout" },
      publication: { state: "not_published" },
    });
    expect(stalled.stream.destroyed).toBe(true);
    expect(state.task).not.toHaveBeenCalled();
    expect(await readFile(previous, "utf8")).toBe(originalText);
    expect(await readdir(outputDir)).toEqual(["previous.md"]);
  });

  it("does no input work for an already cancelled call", async () => {
    const { file, controller, config } = await input();
    controller.abort();
    expect(await executeDocWenTool("docwen_inspect", { file }, config, controller.signal)).toMatchObject({
      error: { code: "docwen_machine_cancelled" },
    });
    expect(state.reads).toEqual([]);
    expect(state.query).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("clears its timer and caller listener after success", async () => {
    const { file, controller, config } = await input();
    expect(await executeDocWenTool("docwen_inspect", { file }, config, controller.signal)).toEqual({
      inspected: true,
    });
    const signal = state.query.mock.calls[0]![0].signal as AbortSignal;
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    controller.abort();
    await vi.advanceTimersByTimeAsync(1000);
    expect(signal.aborted).toBe(false);
  });
});
