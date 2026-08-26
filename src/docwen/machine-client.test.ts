import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { encodeMachineFrame, MachineFrameDecoder, type JsonObject } from "./machine-framing.js";

const { spawnMock, terminateProcessTreeMock, serverState } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  terminateProcessTreeMock: vi.fn(async () => undefined),
  serverState: {
    behavior: "normal",
    cancelRequests: 0,
    corruptHash: false,
    executeSeen: false,
  },
}));

vi.mock("node:child_process", () => ({ spawn: spawnMock }));
vi.mock("../process/runner.js", () => ({ terminateProcessTree: terminateProcessTreeMock }));

import { runDocWenMachineQuery, runDocWenMachineTask, validateArtifactBundle } from "./machine-client.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  try {
    for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true });
  } finally {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  }
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "docwen-openclaw-machine-test-"));
  temporaryRoots.push(root);
  return root;
}

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 1234;
  killed = false;
  exitCode: number | null = null;
  private readonly decoder = new MachineFrameDecoder();
  private taskPlan: JsonObject | null = null;

  constructor() {
    super();
    if (serverState.behavior === "stderr_overflow") {
      queueMicrotask(() => this.stderr.write(Buffer.alloc(256 * 1024 + 1)));
    }
    this.stdin.on("data", (chunk: Buffer) => {
      for (const message of this.decoder.feed(Buffer.from(chunk))) this.handle(message);
    });
    this.stdin.on("finish", () =>
      queueMicrotask(() => {
        this.exitCode = 0;
        this.emit("close", 0);
      }),
    );
  }

  kill(): boolean {
    this.killed = true;
    this.exitCode = null;
    queueMicrotask(() => this.emit("close", null));
    return true;
  }

  private handle(message: JsonObject): void {
    const id = message.id;
    if (message.method === "initialize") {
      if (serverState.behavior === "hang_initialize") return;
      this.reply(id, {
        protocol: { name: "docwen.machine", major: 1, minor: 0 },
        server: { name: "DocWen", version: "0.9.0" },
        methods: [],
        features: { progress: true, cancellation: true },
        artifact_bundle_schema:
          serverState.behavior === "bundle_v1" ? "docwen.artifact_bundle.v1" : "docwen.artifact_bundle.v2",
        max_concurrent_tasks: 1,
      });
      return;
    }
    if (message.method === "health/check") {
      this.reply(id, { all_ok: true, checks: [] });
      return;
    }
    if (message.method === "task/plan") {
      this.taskPlan = message.params as JsonObject;
      this.reply(id, {
        plan_id: "plan.1",
        capability_id: this.taskPlan.capability_id,
        effective_options: {},
        output_shape: {
          cardinality: "one",
          artifact_kinds: ["document"],
          relation_types: [],
          atomic_bundle: true,
        },
        limitations: [],
      });
      return;
    }
    if (message.method === "task/execute") {
      this.reply(id, { task_id: "task.1", state: "accepted" });
      serverState.executeSeen = true;
      if (serverState.behavior === "hang_task") return;
      if (serverState.behavior === "remote_failure") {
        queueMicrotask(() =>
          this.notify("task/failed", {
            task_id: "task.1",
            sequence: 1,
            error: { code: "conversion_failed", message: "synthetic failure" },
          }),
        );
        return;
      }
      const output = ((this.taskPlan!.output as JsonObject).staging_root as JsonObject).path as string;
      const artifactPath = path.join(output, "output.md");
      const bytes = Buffer.from("# output\n", "utf8");
      writeFileSync(artifactPath, bytes);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      queueMicrotask(() =>
        this.notify("task/completed", {
          task_id: "task.1",
          sequence: 1,
          bundle: {
            schema: "docwen.artifact_bundle.v2",
            bundle_id: "bundle.1",
            task_id: "task.1",
            producer: { name: "DocWen", product_version: "0.9.0", machine_protocol: "docwen.machine.v1" },
            layout_schema: "docwen.artifact_layout.v1",
            artifacts: [
              {
                artifact_id: "artifact.1",
                kind: "document",
                locator: "output.md",
                logical_path: "output.md",
                suggested_name: "output.md",
                media_type: "text/markdown",
                size_bytes: bytes.length,
                sha256: serverState.corruptHash ? "0".repeat(64) : sha256,
              },
            ],
            entries: [{ artifact_id: "artifact.1", role: "primary", ordinal: 0, preferred: true }],
            relations: [],
          },
          diagnostics: [],
          metrics: { duration_ms: 1, input_bytes: 1, output_bytes: bytes.length },
        }),
      );
      return;
    }
    if (message.method === "task/cancel") {
      serverState.cancelRequests += 1;
      this.reply(id, { task_id: "task.1", state: "cancellation_requested" });
      queueMicrotask(() =>
        this.notify("task/cancelled", {
          task_id: "task.1",
          sequence: 1,
        }),
      );
    }
  }

  private reply(id: unknown, result: JsonObject): void {
    queueMicrotask(() => this.stdout.write(encodeMachineFrame({ jsonrpc: "2.0", id, result })));
  }

  private notify(method: string, params: JsonObject): void {
    this.stdout.write(encodeMachineFrame({ jsonrpc: "2.0", method, params }));
  }
}

function artifact(artifactId: string, locator: string, bytes: Buffer, kind = "document"): JsonObject {
  return {
    artifact_id: artifactId,
    kind,
    locator,
    logical_path: locator,
    suggested_name: path.basename(locator),
    media_type: "text/markdown",
    size_bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function bundle(artifacts: JsonObject[], entries: JsonObject[], relations: JsonObject[] = []): JsonObject {
  return {
    schema: "docwen.artifact_bundle.v2",
    bundle_id: "bundle.graph",
    task_id: "task.graph",
    producer: { name: "DocWen", product_version: "0.9.0", machine_protocol: "docwen.machine.v1" },
    layout_schema: "docwen.artifact_layout.v1",
    artifacts,
    entries,
    relations,
  };
}

async function taskInvocation(timeoutMs = 1_000, signal?: AbortSignal) {
  const root = await temporaryRoot();
  const input = path.join(root, "input.md");
  const staging = path.join(root, "staging");
  const bytes = Buffer.from("# input\n", "utf8");
  writeFileSync(input, bytes);
  await mkdir(staging);
  return {
    staging,
    options: {
      binaryPath: "C:\\DocWen\\DocWenCLI.exe",
      timeoutMs,
      signal,
      request: {
        capability_id: "transform.markdown.heading_numbering",
        inputs: [
          {
            input_id: "input.1",
            locator: { kind: "local_path" as const, path: input },
            kind: "document" as const,
            role: "source" as const,
            logical_path: "input.md",
            media_type: "text/markdown",
            size_bytes: bytes.length,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          },
        ],
        output: {
          staging_root: { kind: "local_path" as const, path: staging },
          staging_policy: "require_empty" as const,
        },
        options: {},
      },
    },
  };
}

describe("DocWen Machine Protocol client", () => {
  beforeEach(() => {
    spawnMock.mockReset();
    terminateProcessTreeMock.mockClear();
    terminateProcessTreeMock.mockResolvedValue(undefined);
    serverState.behavior = "normal";
    serverState.cancelRequests = 0;
    serverState.corruptHash = false;
    serverState.executeSeen = false;
    spawnMock.mockImplementation(() => new FakeChild());
  });

  it("initializes Machine v1 and performs a framed query", async () => {
    const response = await runDocWenMachineQuery({
      binaryPath: "C:\\DocWen\\DocWenCLI.exe",
      method: "health/check",
      params: {},
      timeoutMs: 1_000,
    });
    expect(response.result).toEqual({ all_ok: true, checks: [] });
    expect(spawnMock).toHaveBeenCalledWith(
      "C:\\DocWen\\DocWenCLI.exe",
      ["serve", "--stdio"],
      expect.objectContaining({ shell: false, windowsHide: true }),
    );
  });

  it("rejects a Machine server that does not declare Artifact Bundle v2", async () => {
    serverState.behavior = "bundle_v1";

    await expect(
      runDocWenMachineQuery({
        binaryPath: "C:\\DocWen\\DocWenCLI.exe",
        method: "health/check",
        params: {},
        timeoutMs: 1_000,
      }),
    ).rejects.toMatchObject({ code: "docwen_machine_incompatible_version" });
  });

  it("forwards only validated DocWen isolation hooks to the child process", async () => {
    vi.stubEnv("DOCWEN_CONFIG_DIR", "  C:\\isolated docwen\\config  ");
    vi.stubEnv("DOCWEN_LOG_DIR", "C:\\isolated docwen\\logs");
    vi.stubEnv("DOCWEN_LOG_TO_TEMP", "YES");
    vi.stubEnv("DOCWEN_API_TOKEN", "must-not-leak");
    vi.stubEnv("DOCWEN_UNKNOWN", "must-not-leak");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "must-not-leak");
    vi.stubEnv("NODE_OPTIONS", "--inspect=127.0.0.1:9229");
    vi.stubEnv("HOME", "C:\\sensitive-home");

    await runDocWenMachineQuery({
      binaryPath: "C:\\DocWen\\DocWenCLI.exe",
      method: "health/check",
      params: {},
      timeoutMs: 1_000,
    });

    const environment = spawnMock.mock.calls[0]![2].env as NodeJS.ProcessEnv;
    expect(environment).toMatchObject({
      DOCWEN_CONFIG_DIR: "C:\\isolated docwen\\config",
      DOCWEN_LOG_DIR: "C:\\isolated docwen\\logs",
      DOCWEN_LOG_TO_TEMP: "1",
      NO_COLOR: "1",
      PYTHONIOENCODING: "utf-8",
      PYTHONUTF8: "1",
    });
    for (const key of [
      "DOCWEN_API_TOKEN",
      "DOCWEN_UNKNOWN",
      "AWS_SECRET_ACCESS_KEY",
      "NODE_OPTIONS",
      "HOME",
    ]) {
      expect(environment).not.toHaveProperty(key);
    }
  });

  it("drops empty and false DocWen isolation hook values", async () => {
    vi.stubEnv("DOCWEN_CONFIG_DIR", " \t ");
    vi.stubEnv("DOCWEN_LOG_DIR", " \r\n ");
    vi.stubEnv("DOCWEN_LOG_TO_TEMP", "false");

    await runDocWenMachineQuery({
      binaryPath: "C:\\DocWen\\DocWenCLI.exe",
      method: "health/check",
      params: {},
      timeoutMs: 1_000,
    });

    const environment = spawnMock.mock.calls[0]![2].env as NodeJS.ProcessEnv;
    expect(environment).not.toHaveProperty("DOCWEN_CONFIG_DIR");
    expect(environment).not.toHaveProperty("DOCWEN_LOG_DIR");
    expect(environment).not.toHaveProperty("DOCWEN_LOG_TO_TEMP");
  });

  it("validates every artifact before returning a completed task", async () => {
    const root = await temporaryRoot();
    const input = path.join(root, "input.md");
    const staging = path.join(root, "staging");
    writeFileSync(input, "# input\n", "utf8");
    await mkdir(staging);
    const bytes = Buffer.from("# input\n", "utf8");
    const result = await runDocWenMachineTask({
      binaryPath: "C:\\DocWen\\DocWenCLI.exe",
      timeoutMs: 1_000,
      request: {
        capability_id: "transform.markdown.heading_numbering",
        inputs: [
          {
            input_id: "input.1",
            locator: { kind: "local_path", path: input },
            kind: "document",
            role: "source",
            logical_path: "input.md",
            media_type: "text/markdown",
            size_bytes: bytes.length,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          },
        ],
        output: { staging_root: { kind: "local_path", path: staging }, staging_policy: "require_empty" },
        options: {},
      },
    });
    expect(result.bundle.artifacts[0]).toMatchObject({
      logical_path: "output.md",
      kind: "document",
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
  });

  it("validates Bundle v2 logical paths and document-node manifest relations", async () => {
    const root = await temporaryRoot();
    const documentBytes = Buffer.from("# document\n", "utf8");
    const manifestBytes = Buffer.from("{}\n", "utf8");
    writeFileSync(path.join(root, "document.md"), documentBytes);
    writeFileSync(path.join(root, "node.json"), manifestBytes);
    const document = artifact("document.1", "document.md", documentBytes);
    document.logical_path = "report/document.md";
    const manifest = artifact("resource.manifest", "node.json", manifestBytes, "resource");
    manifest.logical_path = "report/.docwen/document-node.json";
    const value = {
      schema: "docwen.artifact_bundle.v2",
      bundle_id: "bundle.v2",
      task_id: "task.graph",
      producer: { name: "DocWen", product_version: "0.9.0", machine_protocol: "docwen.machine.v1" },
      layout_schema: "docwen.document_node.v1",
      artifacts: [document, manifest],
      entries: [{ artifact_id: "document.1", role: "primary", ordinal: 0, preferred: true }],
      relations: [
        {
          type: "resource_of",
          source_artifact_id: "resource.manifest",
          target_artifact_id: "document.1",
          role: "manifest",
        },
      ],
    };

    await expect(validateArtifactBundle(value, root, "task.graph")).resolves.toMatchObject({
      schema: "docwen.artifact_bundle.v2",
      layout_schema: "docwen.document_node.v1",
      artifacts: [
        { artifact_id: "document.1", logical_path: "report/document.md" },
        { artifact_id: "resource.manifest", logical_path: "report/.docwen/document-node.json" },
      ],
    });

    await expect(
      validateArtifactBundle({ ...value, schema: "docwen.artifact_bundle.v1" }, root, "task.graph"),
    ).rejects.toMatchObject({ code: "docwen_machine_integrity_error" });

    delete document.logical_path;
    await expect(validateArtifactBundle(value, root, "task.graph")).rejects.toMatchObject({
      code: "docwen_machine_protocol_error",
    });
  });

  it("fails closed before disk reads when Bundle count, file, or aggregate limits are exceeded", async () => {
    const root = await temporaryRoot();
    const empty = Buffer.alloc(0);
    const countArtifacts = Array.from({ length: 257 }, (_, index) =>
      artifact(`artifact.${index}`, `artifact-${index}.md`, empty),
    );
    await expect(
      validateArtifactBundle(bundle(countArtifacts, []), root, "task.graph"),
    ).rejects.toMatchObject({
      code: "docwen_machine_output_limit",
      details: { artifactCount: 257, artifactCountLimit: 256 },
    });

    const tooLarge = artifact("artifact.large", "large.md", empty);
    tooLarge.size_bytes = 512 * 1024 * 1024 + 1;
    await expect(validateArtifactBundle(bundle([tooLarge], []), root, "task.graph")).rejects.toMatchObject({
      code: "docwen_machine_output_limit",
      details: { artifactBytesLimit: 512 * 1024 * 1024 },
    });

    const aggregate = Array.from({ length: 3 }, (_, index) => {
      const value = artifact(`artifact.total.${index}`, `total-${index}.md`, empty);
      value.size_bytes = 400 * 1024 * 1024;
      return value;
    });
    await expect(validateArtifactBundle(bundle(aggregate, []), root, "task.graph")).rejects.toMatchObject({
      code: "docwen_machine_output_limit",
      details: { artifactBundleBytesLimit: 1024 * 1024 * 1024 },
    });
  });

  it("times out a stalled child and terminates its process tree exactly once", async () => {
    serverState.behavior = "hang_initialize";
    await expect(
      runDocWenMachineQuery({
        binaryPath: "C:\\DocWen\\DocWenCLI.exe",
        method: "health/check",
        params: {},
        timeoutMs: 20,
      }),
    ).rejects.toMatchObject({ code: "docwen_machine_timeout", details: { timeoutMs: 20 } });
    expect(terminateProcessTreeMock).toHaveBeenCalledTimes(1);
  });

  it("requests task cancellation, rejects the terminal state, and terminates the process tree", async () => {
    serverState.behavior = "hang_task";
    const controller = new AbortController();
    const invocation = await taskInvocation(1_000, controller.signal);
    const operation = runDocWenMachineTask(invocation.options);
    await vi.waitFor(() => expect(serverState.executeSeen).toBe(true));
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort();

    await expect(operation).rejects.toMatchObject({ code: "docwen_machine_cancelled" });
    expect(serverState.cancelRequests).toBe(1);
    expect(terminateProcessTreeMock).toHaveBeenCalledTimes(1);
    expect(await readdir(invocation.staging)).toEqual([]);
  });

  it("fails closed on stderr overflow and terminates the process tree", async () => {
    serverState.behavior = "stderr_overflow";
    await expect(
      runDocWenMachineQuery({
        binaryPath: "C:\\DocWen\\DocWenCLI.exe",
        method: "health/check",
        params: {},
        timeoutMs: 1_000,
      }),
    ).rejects.toMatchObject({ code: "docwen_machine_output_limit" });
    expect(terminateProcessTreeMock).toHaveBeenCalledTimes(1);
  });

  it("preserves a remote task failure without publishing state and terminates the process tree", async () => {
    serverState.behavior = "remote_failure";
    const invocation = await taskInvocation();
    await expect(runDocWenMachineTask(invocation.options)).rejects.toMatchObject({
      code: "docwen_machine_remote:conversion_failed",
    });
    expect(terminateProcessTreeMock).toHaveBeenCalledTimes(1);
    expect(await readdir(invocation.staging)).toEqual([]);
  });

  it("fails closed on content mismatch, unsafe locators, and invalid relation graphs", async () => {
    const root = await temporaryRoot();
    const bytesA = Buffer.from("# A\n", "utf8");
    const bytesB = Buffer.from("# B\n", "utf8");
    writeFileSync(path.join(root, "a.md"), bytesA);
    writeFileSync(path.join(root, "b.md"), bytesB);
    const entry = { artifact_id: "artifact.a", role: "primary", ordinal: 0, preferred: true };

    await expect(
      validateArtifactBundle(
        bundle([artifact("artifact.a", "../a.md", bytesA)], [entry]),
        root,
        "task.graph",
      ),
    ).rejects.toMatchObject({ code: "docwen_machine_integrity_error" });

    await expect(
      validateArtifactBundle(
        bundle(
          [artifact("artifact.a", "a.md", bytesA), artifact("artifact.b", "b.md", bytesB)],
          [entry],
          [
            {
              type: "derived_from",
              source_artifact_id: "artifact.a",
              target_artifact_id: "artifact.b",
              role: "source",
            },
            {
              type: "derived_from",
              source_artifact_id: "artifact.b",
              target_artifact_id: "artifact.a",
              role: "source",
            },
          ],
        ),
        root,
        "task.graph",
      ),
    ).rejects.toMatchObject({ code: "docwen_machine_integrity_error" });
  });

  it("accepts peer entries without a preferred hint and rejects multiple hints", async () => {
    const root = await temporaryRoot();
    const bytes = Buffer.from("# peer\n", "utf8");
    writeFileSync(path.join(root, "peer.md"), bytes);
    const peerArtifact = artifact("artifact.peer", "peer.md", bytes);

    await expect(
      validateArtifactBundle(
        bundle(
          [peerArtifact],
          [{ artifact_id: "artifact.peer", role: "section", ordinal: 0, preferred: false }],
        ),
        root,
        "task.graph",
      ),
    ).resolves.toMatchObject({ bundle_id: "bundle.graph" });

    await expect(
      validateArtifactBundle(
        bundle(
          [peerArtifact],
          [
            { artifact_id: "artifact.peer", role: "primary", ordinal: 0, preferred: true },
            { artifact_id: "artifact.peer", role: "section", ordinal: 1, preferred: true },
          ],
        ),
        root,
        "task.graph",
      ),
    ).rejects.toMatchObject({ code: "docwen_machine_integrity_error" });
  });

  it("fails closed when the manifest hash does not match disk", async () => {
    serverState.corruptHash = true;
    const root = await temporaryRoot();
    const input = path.join(root, "input.md");
    const staging = path.join(root, "staging");
    writeFileSync(input, "# input\n", "utf8");
    await mkdir(staging);
    const bytes = Buffer.from("# input\n", "utf8");
    await expect(
      runDocWenMachineTask({
        binaryPath: "C:\\DocWen\\DocWenCLI.exe",
        timeoutMs: 1_000,
        request: {
          capability_id: "transform.markdown.heading_numbering",
          inputs: [
            {
              input_id: "input.1",
              locator: { kind: "local_path", path: input },
              kind: "document",
              role: "source",
              logical_path: "input.md",
              media_type: "text/markdown",
              size_bytes: bytes.length,
              sha256: createHash("sha256").update(bytes).digest("hex"),
            },
          ],
          output: { staging_root: { kind: "local_path", path: staging }, staging_policy: "require_empty" },
          options: {},
        },
      }),
    ).rejects.toMatchObject({ code: "docwen_machine_integrity_error" });
  });
});
