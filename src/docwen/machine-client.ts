import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import * as path from "node:path";

import { terminateProcessTree } from "../process/runner.js";
import { encodeMachineFrame, isJsonObject, MachineFrameDecoder, type JsonObject } from "./machine-framing.js";

export type { JsonObject } from "./machine-framing.js";

const CLIENT_NAME = "DocWen OpenClaw";
const CLIENT_VERSION = "2.0.0";
const STDERR_LIMIT_BYTES = 256 * 1024;
const MAX_ARTIFACT_COUNT = 256;
const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;
const MAX_ARTIFACT_BUNDLE_BYTES = 1024 * 1024 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

export class DocWenMachineError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: JsonObject = {},
  ) {
    super(message);
    this.name = "DocWenMachineError";
  }
}

export type MachineInputKind = "document" | "resource";
export type MachineInputRole =
  | "source"
  | "linked_resource"
  | "bibliography"
  | "citation_style"
  | "neutral_document"
  | "numbering_export_plan";

export type MachineInputHandle = {
  input_id: string;
  locator: { kind: "local_path"; path: string };
  kind: MachineInputKind;
  role: MachineInputRole;
  logical_path: string;
  media_type: string;
  size_bytes: number;
  sha256: string;
};

export type MachineTaskRequest = {
  capability_id: string;
  inputs: readonly MachineInputHandle[];
  output: {
    staging_root: { kind: "local_path"; path: string };
    staging_policy: "require_empty";
  };
  options: JsonObject;
};

export type MachineCapability = {
  capability_id: string;
  operation: string;
  input_shape: {
    slots: Array<{
      role: MachineInputRole;
      kind: MachineInputKind;
      media_types: string[];
      min_items: number;
      max_items?: number;
    }>;
    undeclared_roles: "reject";
  };
  output_media_types: string[];
  output_shape: {
    cardinality: "one" | "many";
    artifact_kinds: Array<"document" | "fragment" | "resource">;
    relation_types: string[];
    atomic_bundle: true;
  };
  options_schema: JsonObject;
  availability: "available" | "limited" | "unavailable";
  dependencies: JsonObject[];
  limitations: JsonObject[];
};

export type ValidatedBundleArtifact = {
  artifact_id: string;
  kind: "document" | "fragment" | "resource";
  locator: string;
  logical_path: string;
  suggested_name: string;
  media_type: string;
  size_bytes: number;
  sha256: string;
  absolutePath: string;
};

export type ValidatedArtifactBundle = {
  schema: "docwen.artifact_bundle.v2";
  bundle_id: string;
  task_id: string;
  producer: {
    name: "DocWen";
    product_version: string;
    machine_protocol: "docwen.machine.v1";
  };
  layout_schema: "docwen.artifact_layout.v1" | "docwen.document_node.v1";
  artifacts: ValidatedBundleArtifact[];
  entries: JsonObject[];
  relations: JsonObject[];
};

export type MachineTaskCompleted = {
  taskId: string;
  plan: JsonObject;
  bundle: ValidatedArtifactBundle;
  diagnostics: JsonObject[];
  metrics: JsonObject;
  progress: JsonObject[];
};

type PendingReader = {
  resolve: (message: JsonObject) => void;
  reject: (error: Error) => void;
};

class MessageQueue {
  private readonly messages: JsonObject[] = [];
  private readonly readers: PendingReader[] = [];
  private failure?: Error;

  push(message: JsonObject): void {
    if (this.failure) return;
    const reader = this.readers.shift();
    if (reader) reader.resolve(message);
    else this.messages.push(message);
  }

  fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    this.messages.length = 0;
    for (const reader of this.readers.splice(0)) reader.reject(error);
  }

  next(): Promise<JsonObject> {
    if (this.failure) return Promise.reject(this.failure);
    const message = this.messages.shift();
    if (message) return Promise.resolve(message);
    return new Promise((resolve, reject) => this.readers.push({ resolve, reject }));
  }
}

class MachineSession {
  private readonly queue = new MessageQueue();
  private readonly decoder = new MachineFrameDecoder();
  private readonly deferred: JsonObject[] = [];
  private readonly stderr: Buffer[] = [];
  private stderrBytes = 0;
  private nextRequestId = 0;
  private normalClose = false;
  private termination?: Promise<void>;
  private readonly closed: Promise<number | null>;
  readonly child: ChildProcessWithoutNullStreams;

  constructor(binaryPath: string, locale?: string) {
    try {
      this.child = spawn(binaryPath, ["serve", "--stdio"], {
        cwd: path.dirname(binaryPath),
        env: boundedEnvironment(locale),
        shell: false,
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      throw localError("docwen_machine_spawn_failed", "Unable to start DocWen Machine Protocol.", error);
    }
    this.closed = new Promise((resolve) => {
      this.child.once("close", resolve);
      this.child.once("error", (error) => {
        this.fail(localError("docwen_machine_spawn_failed", "DocWen process failed.", error));
        resolve(null);
      });
    });
    this.child.stdout.on("data", (chunk: Buffer) => {
      try {
        for (const message of this.decoder.feed(Buffer.from(chunk))) this.queue.push(message);
      } catch (error) {
        this.fail(protocolError(error));
      }
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      const bytes = Buffer.from(chunk);
      this.stderrBytes += bytes.length;
      if (this.stderrBytes <= STDERR_LIMIT_BYTES) this.stderr.push(bytes);
      else {
        this.fail(new DocWenMachineError("docwen_machine_output_limit", "DocWen stderr exceeded its limit."));
        void this.terminate();
      }
    });
    this.child.once("close", (code) => {
      try {
        this.decoder.finish();
      } catch (error) {
        this.fail(protocolError(error));
        return;
      }
      if (!this.normalClose) {
        this.fail(
          new DocWenMachineError(
            "docwen_machine_protocol_error",
            "DocWen exited before the operation completed.",
            { exitCode: code },
          ),
        );
      }
    });
  }

  async initialize(): Promise<JsonObject> {
    const result = await this.rpc("initialize", {
      protocol: { name: "docwen.machine", major: 1, minor: 0 },
      client: { name: CLIENT_NAME, version: CLIENT_VERSION },
      features: { progress: true, cancellation: true },
    });
    const protocol = requiredObject(result.protocol, "initialize.protocol");
    if (
      protocol.name !== "docwen.machine" ||
      protocol.major !== 1 ||
      protocol.minor !== 0 ||
      result.artifact_bundle_schema !== "docwen.artifact_bundle.v2"
    ) {
      throw new DocWenMachineError(
        "docwen_machine_incompatible_version",
        "DocWen Machine Protocol v1 and Artifact Bundle v2 are required.",
      );
    }
    return result;
  }

  async rpc(method: string, params: JsonObject): Promise<JsonObject> {
    const id = ++this.nextRequestId;
    this.send({ jsonrpc: "2.0", id, method, params });
    while (true) {
      const message = await this.queue.next();
      if (message.id !== id) {
        this.deferred.push(message);
        continue;
      }
      if (message.jsonrpc !== "2.0") throw protocolError(`invalid JSON-RPC response for ${method}`);
      if (isJsonObject(message.error)) throw remoteRpcError(message.error);
      return requiredObject(message.result, `${method}.result`);
    }
  }

  nextMessage(): Promise<JsonObject> {
    const message = this.deferred.shift();
    return message ? Promise.resolve(message) : this.queue.next();
  }

  requestCancellation(taskId: string): void {
    this.send({
      jsonrpc: "2.0",
      id: ++this.nextRequestId,
      method: "task/cancel",
      params: { task_id: taskId },
    });
  }

  fail(error: Error): void {
    this.deferred.length = 0;
    this.queue.fail(error);
  }

  async close(): Promise<void> {
    this.normalClose = true;
    this.child.stdin.end();
    const code = await this.closed;
    const stderrText = Buffer.concat(this.stderr).toString("utf8");
    if (code !== 0) {
      throw new DocWenMachineError("docwen_machine_protocol_error", "DocWen exited with an error.", {
        exitCode: code,
        stderr: stderrText,
      });
    }
    if (stderrText.length > 0) {
      throw new DocWenMachineError("docwen_machine_protocol_error", "DocWen wrote unexpected stderr.", {
        stderr: stderrText,
      });
    }
  }

  terminate(): Promise<void> {
    if (this.termination) return this.termination;
    this.normalClose = true;
    this.child.stdin.destroy();
    this.termination = terminateProcessTree(this.child).catch(() => undefined);
    return this.termination;
  }

  private send(message: JsonObject): void {
    if (this.child.stdin.destroyed) throw protocolError("DocWen stdin is closed");
    this.child.stdin.write(encodeMachineFrame(message));
  }
}

export async function runDocWenMachineQuery(options: {
  binaryPath: string;
  method: string;
  params: JsonObject;
  timeoutMs: number;
  signal?: AbortSignal;
  locale?: string;
}): Promise<{ initialize: JsonObject; result: JsonObject }> {
  return withSession(
    options,
    async (session) => ({
      initialize: await session.initialize(),
      result: await session.rpc(options.method, options.params),
    }),
    false,
  );
}

export async function runDocWenMachineTask(options: {
  binaryPath: string;
  request: MachineTaskRequest;
  timeoutMs: number;
  signal?: AbortSignal;
  locale?: string;
}): Promise<MachineTaskCompleted> {
  return withSession(options, async (session, setTaskId) => {
    await session.initialize();
    const plan = await session.rpc("task/plan", options.request);
    const planId = requiredString(plan.plan_id, "task/plan.plan_id");
    const acceptance = await session.rpc("task/execute", { plan_id: planId });
    const taskId = requiredString(acceptance.task_id, "task/execute.task_id");
    if (acceptance.state !== "accepted") throw protocolError("task/execute did not accept the task");
    setTaskId(taskId);
    const progress: JsonObject[] = [];
    let lastSequence = 0;
    while (true) {
      const message = await session.nextMessage();
      if (message.id !== undefined) continue;
      const params = requiredObject(message.params, "notification.params");
      if (params.task_id !== taskId) throw protocolError("notification task id does not match acceptance");
      const sequence = requiredInteger(params.sequence, "notification.sequence");
      if (sequence <= lastSequence) throw protocolError("notification sequence is not strictly monotonic");
      lastSequence = sequence;
      if (message.method === "task/progress") {
        progress.push(params);
        continue;
      }
      if (message.method === "task/failed") throw remoteTaskError(params);
      if (message.method === "task/cancelled") {
        throw new DocWenMachineError("docwen_machine_cancelled", "DocWen task was cancelled.");
      }
      if (message.method !== "task/completed") throw protocolError("unexpected Machine notification");
      if (options.signal?.aborted) {
        throw new DocWenMachineError("docwen_machine_cancelled", "DocWen task was cancelled.");
      }
      return {
        taskId,
        plan,
        bundle: await validateArtifactBundle(params.bundle, options.request.output.staging_root.path, taskId),
        diagnostics: objectArray(params.diagnostics, "terminal.diagnostics"),
        metrics: requiredObject(params.metrics, "terminal.metrics"),
        progress,
      };
    }
  });
}

async function withSession<T>(
  options: { binaryPath: string; timeoutMs: number; signal?: AbortSignal; locale?: string },
  body: (session: MachineSession, setTaskId: (taskId: string) => void) => Promise<T>,
  initializeInBody = true,
): Promise<T> {
  if (options.signal?.aborted) {
    throw new DocWenMachineError("docwen_machine_cancelled", "DocWen operation was cancelled before start.");
  }
  const session = new MachineSession(options.binaryPath, options.locale);
  let taskId: string | null = null;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    session.fail(
      new DocWenMachineError("docwen_machine_timeout", "DocWen Machine Protocol timed out.", {
        timeoutMs: options.timeoutMs,
      }),
    );
    void session.terminate();
  }, options.timeoutMs);
  const onAbort = (): void => {
    if (taskId) session.requestCancellation(taskId);
    else {
      session.fail(new DocWenMachineError("docwen_machine_cancelled", "DocWen operation was cancelled."));
      void session.terminate();
    }
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    if (!initializeInBody) {
      const result = await body(session, (value) => {
        taskId = value;
      });
      await session.close();
      return result;
    }
    const result = await body(session, (value) => {
      taskId = value;
    });
    await session.close();
    return result;
  } catch (error) {
    await session.terminate();
    if (timedOut) {
      throw new DocWenMachineError("docwen_machine_timeout", "DocWen Machine Protocol timed out.", {
        timeoutMs: options.timeoutMs,
      });
    }
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

export async function validateArtifactBundle(
  value: unknown,
  stagingRoot: string,
  taskId: string,
): Promise<ValidatedArtifactBundle> {
  const bundle = requiredObject(value, "bundle");
  if (bundle.schema !== "docwen.artifact_bundle.v2" || bundle.task_id !== taskId) {
    throw integrityError("Artifact Bundle schema or task identity is invalid.");
  }
  const layoutSchema = bundle.layout_schema;
  if (layoutSchema !== "docwen.artifact_layout.v1" && layoutSchema !== "docwen.document_node.v1") {
    throw integrityError("Artifact Bundle layout schema is invalid.");
  }
  const validatedLayoutSchema = layoutSchema as "docwen.artifact_layout.v1" | "docwen.document_node.v1";
  const producer = requiredObject(bundle.producer, "bundle.producer");
  if (
    producer.name !== "DocWen" ||
    producer.machine_protocol !== "docwen.machine.v1" ||
    typeof producer.product_version !== "string" ||
    producer.product_version.length === 0
  ) {
    throw integrityError("Artifact Bundle producer identity is invalid.");
  }
  const root = await realpath(stagingRoot);
  const rawArtifacts = objectArray(bundle.artifacts, "bundle.artifacts");
  if (rawArtifacts.length === 0) throw integrityError("Artifact Bundle is empty.");
  enforceArtifactBundleLimits(rawArtifacts);
  const artifactIds = new Set<string>();
  const artifactLocators = new Set<string>();
  const artifacts: ValidatedBundleArtifact[] = [];
  for (const raw of rawArtifacts) {
    const artifactId = requiredString(raw.artifact_id, "artifact.artifact_id");
    if (artifactIds.has(artifactId)) throw integrityError("Artifact Bundle contains duplicate artifact ids.");
    artifactIds.add(artifactId);
    const kind = raw.kind;
    if (kind !== "document" && kind !== "fragment" && kind !== "resource") {
      throw integrityError("Artifact Bundle contains an invalid artifact kind.");
    }
    const locator = safeLocator(raw.locator);
    if (artifactLocators.has(locator)) throw integrityError("Artifact Bundle contains duplicate locators.");
    artifactLocators.add(locator);
    const logicalPath = safeLogicalPath(raw.logical_path);
    const suggestedName = requiredString(raw.suggested_name, "artifact.suggested_name");
    if (
      path.basename(suggestedName) !== suggestedName ||
      suggestedName.includes("\\") ||
      suggestedName.includes("/")
    ) {
      throw integrityError("Artifact suggested_name must be a plain filename.");
    }
    const mediaType = requiredString(raw.media_type, "artifact.media_type");
    const sizeBytes = requiredInteger(raw.size_bytes, "artifact.size_bytes");
    const sha256 = requiredString(raw.sha256, "artifact.sha256");
    if (!SHA256_PATTERN.test(sha256)) throw integrityError("Artifact sha256 is invalid.");
    const absolutePath = path.resolve(root, ...locator.split("/"));
    if (!isContainedPath(root, absolutePath)) throw integrityError("Artifact locator escapes staging.");
    const fileInfo = await lstat(absolutePath);
    if (!fileInfo.isFile() || fileInfo.isSymbolicLink())
      throw integrityError("Artifact is not a regular file.");
    const canonicalPath = await realpath(absolutePath);
    if (!isContainedPath(root, canonicalPath)) throw integrityError("Artifact resolves outside staging.");
    const actual = await stat(canonicalPath, { bigint: true });
    if (actual.size !== BigInt(sizeBytes)) throw integrityError("Artifact size does not match its manifest.");
    const digest = await hashArtifactFile(canonicalPath, actual);
    if (digest !== sha256) throw integrityError("Artifact sha256 does not match its content.");
    artifacts.push({
      artifact_id: artifactId,
      kind,
      locator,
      logical_path: logicalPath,
      suggested_name: suggestedName,
      media_type: mediaType,
      size_bytes: sizeBytes,
      sha256,
      absolutePath: canonicalPath,
    });
  }
  const entries = objectArray(bundle.entries, "bundle.entries");
  if (entries.length === 0) throw integrityError("Artifact Bundle has no entries.");
  if (entries.filter((entry) => entry.preferred === true).length > 1) {
    throw integrityError("Artifact Bundle has more than one preferred entry.");
  }
  const entryIds = new Set<string>();
  const entryOrdinals = new Set<number>();
  for (const entry of entries) {
    const artifactId = requiredString(entry.artifact_id, "entry.artifact_id");
    if (!artifactIds.has(artifactId)) throw integrityError("Bundle entry references an unknown artifact.");
    const ordinal = requiredInteger(entry.ordinal, "entry.ordinal");
    if (entryIds.has(artifactId) || entryOrdinals.has(ordinal)) {
      throw integrityError("Artifact Bundle contains duplicate entries or entry ordinals.");
    }
    entryIds.add(artifactId);
    entryOrdinals.add(ordinal);
    if (typeof entry.preferred !== "boolean") throw integrityError("Bundle entry preferred flag is invalid.");
    const role = requiredString(entry.role, "entry.role");
    if (
      !["primary", "supplementary", "ocr_page", "section", "worksheet", "image", "original"].includes(role)
    ) {
      throw integrityError("Bundle entry role is invalid.");
    }
    const artifact = artifacts.find((item) => item.artifact_id === artifactId)!;
    if (role === "ocr_page" && artifact.kind !== "fragment")
      throw integrityError("ocr_page entry is not a fragment.");
    if (role === "section" && artifact.kind !== "document" && artifact.kind !== "fragment") {
      throw integrityError("section entry is not a document or fragment.");
    }
    if (role === "image" && artifact.kind !== "resource")
      throw integrityError("image entry is not a resource.");
  }
  const relations = objectArray(bundle.relations, "bundle.relations");
  validateRelations(artifacts, entryIds, relations);
  return {
    schema: bundle.schema,
    bundle_id: requiredString(bundle.bundle_id, "bundle.bundle_id"),
    task_id: taskId,
    producer: {
      name: "DocWen",
      product_version: producer.product_version,
      machine_protocol: "docwen.machine.v1",
    },
    layout_schema: validatedLayoutSchema,
    artifacts,
    entries,
    relations,
  };
}

function enforceArtifactBundleLimits(rawArtifacts: JsonObject[]): void {
  if (rawArtifacts.length > MAX_ARTIFACT_COUNT) {
    throw outputLimitError("Artifact Bundle contains too many artifacts.", {
      artifactCount: rawArtifacts.length,
      artifactCountLimit: MAX_ARTIFACT_COUNT,
    });
  }
  let totalBytes = 0;
  for (const raw of rawArtifacts) {
    const sizeBytes = requiredInteger(raw.size_bytes, "artifact.size_bytes");
    if (sizeBytes > MAX_ARTIFACT_BYTES) {
      throw outputLimitError("Artifact exceeds the per-file size limit.", {
        artifactBytes: sizeBytes,
        artifactBytesLimit: MAX_ARTIFACT_BYTES,
      });
    }
    if (totalBytes > MAX_ARTIFACT_BUNDLE_BYTES - sizeBytes) {
      throw outputLimitError("Artifact Bundle exceeds the aggregate size limit.", {
        artifactBundleBytesLimit: MAX_ARTIFACT_BUNDLE_BYTES,
      });
    }
    totalBytes += sizeBytes;
  }
}

async function hashArtifactFile(canonicalPath: string, expected: BigIntStats): Promise<string> {
  const handle = await open(canonicalPath, "r");
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || !sameFileIdentity(before, expected)) {
      throw integrityError("Artifact changed before integrity verification.");
    }
    const hash = createHash("sha256");
    let bytesRead = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (bytesRead > MAX_ARTIFACT_BYTES - bytes.length) {
        throw outputLimitError("Artifact exceeds the per-file size limit while being read.", {
          artifactBytesLimit: MAX_ARTIFACT_BYTES,
        });
      }
      bytesRead += bytes.length;
      hash.update(bytes);
    }
    const after = await handle.stat({ bigint: true });
    if (!sameFileIdentity(before, after) || BigInt(bytesRead) !== expected.size) {
      throw integrityError("Artifact changed during integrity verification.");
    }
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function validateRelations(
  artifacts: ValidatedBundleArtifact[],
  entryIds: Set<string>,
  relations: JsonObject[],
): void {
  const artifactIds = new Set(artifacts.map((artifact) => artifact.artifact_id));
  const byId = new Map(artifacts.map((artifact) => [artifact.artifact_id, artifact]));
  const relationKeys = new Set<string>();
  const structuralOwners = new Set<string>();
  const orderedSlots = new Set<string>();
  const adjacency = new Map(artifacts.map((artifact) => [artifact.artifact_id, new Set<string>()]));
  const directed = new Map(artifacts.map((artifact) => [artifact.artifact_id, new Set<string>()]));
  const relationRoles: Record<string, readonly string[]> = {
    attachment_of: ["attachment"],
    fragment_of: ["ocr_page", "ocr_text", "section", "worksheet"],
    resource_of: ["image", "original", "preview", "worksheet", "manifest"],
    derived_from: ["source", "original"],
  };
  for (const relation of relations) {
    const type = requiredString(relation.type, "relation.type");
    const sourceId = requiredString(relation.source_artifact_id, "relation.source_artifact_id");
    const targetId = requiredString(relation.target_artifact_id, "relation.target_artifact_id");
    const role = requiredString(relation.role, "relation.role");
    if (!Object.hasOwn(relationRoles, type) || !relationRoles[type]!.includes(role)) {
      throw integrityError("Bundle relation type or role is invalid.");
    }
    if (!artifactIds.has(sourceId) || !artifactIds.has(targetId) || sourceId === targetId) {
      throw integrityError("Bundle relation graph is invalid.");
    }
    const ordinal =
      relation.ordinal === undefined ? null : requiredInteger(relation.ordinal, "relation.ordinal");
    if ((type === "attachment_of" || type === "fragment_of") && ordinal === null) {
      throw integrityError("Ordered Bundle relation is missing an ordinal.");
    }
    const key = `${type}\u0000${sourceId}\u0000${targetId}\u0000${role}\u0000${String(ordinal)}`;
    if (relationKeys.has(key)) throw integrityError("Artifact Bundle contains duplicate relations.");
    relationKeys.add(key);
    const source = byId.get(sourceId)!;
    const target = byId.get(targetId)!;
    if (type === "attachment_of" && (source.kind !== "document" || target.kind !== "document")) {
      throw integrityError("attachment_of relation kinds are invalid.");
    }
    if (type === "fragment_of" && (source.kind !== "fragment" || target.kind !== "document")) {
      throw integrityError("fragment_of relation kinds are invalid.");
    }
    if (
      type === "resource_of" &&
      (source.kind !== "resource" || (target.kind !== "document" && target.kind !== "fragment"))
    ) {
      throw integrityError("resource_of relation kinds are invalid.");
    }
    if (type !== "derived_from") {
      if (structuralOwners.has(sourceId) || entryIds.has(sourceId)) {
        throw integrityError("Artifact has multiple roots or structural owners.");
      }
      structuralOwners.add(sourceId);
    }
    if (ordinal !== null) {
      const slot = `${type}\u0000${targetId}\u0000${ordinal}`;
      if (orderedSlots.has(slot)) throw integrityError("Bundle relation ordinal is duplicated.");
      orderedSlots.add(slot);
    }
    adjacency.get(sourceId)!.add(targetId);
    adjacency.get(targetId)!.add(sourceId);
    directed.get(sourceId)!.add(targetId);
  }
  const visited = new Set<string>();
  const visit = (artifactId: string, active: Set<string>): void => {
    if (active.has(artifactId)) throw integrityError("Artifact Bundle relation graph contains a cycle.");
    if (visited.has(artifactId)) return;
    active.add(artifactId);
    for (const targetId of directed.get(artifactId)!) visit(targetId, active);
    active.delete(artifactId);
    visited.add(artifactId);
  };
  for (const artifactId of artifactIds) visit(artifactId, new Set());
  const reachable = new Set(entryIds);
  const pending = [...entryIds];
  while (pending.length > 0) {
    const artifactId = pending.pop()!;
    for (const neighbor of adjacency.get(artifactId)!) {
      if (reachable.has(neighbor)) continue;
      reachable.add(neighbor);
      pending.push(neighbor);
    }
  }
  if (reachable.size !== artifacts.length)
    throw integrityError("Artifact Bundle contains unreachable artifacts.");
}

function safeLogicalPath(value: unknown): string {
  const logicalPath = requiredString(value, "artifact.logical_path");
  if (
    logicalPath.includes("\\") ||
    logicalPath.startsWith("/") ||
    logicalPath.endsWith("/") ||
    Buffer.byteLength(logicalPath, "utf8") > 4096
  ) {
    throw integrityError("Artifact logical_path is not a portable relative path.");
  }
  const segments = logicalPath.split("/");
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === ".." || segment.includes(":"),
    )
  ) {
    throw integrityError("Artifact logical_path contains an unsafe segment.");
  }
  return logicalPath;
}

function safeLocator(value: unknown): string {
  const locator = requiredString(value, "artifact.locator");
  if (locator.includes("\\") || locator.startsWith("/") || locator.endsWith("/")) {
    throw integrityError("Artifact locator is not a portable relative path.");
  }
  const segments = locator.split("/");
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === ".." || segment.includes(":"),
    )
  ) {
    throw integrityError("Artifact locator contains an unsafe segment.");
  }
  return locator;
}

function isContainedPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative.length > 0 &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function requiredObject(value: unknown, field: string): JsonObject {
  if (!isJsonObject(value)) throw protocolError(`${field} must be an object`);
  return value;
}

function objectArray(value: unknown, field: string): JsonObject[] {
  if (!Array.isArray(value) || value.some((item) => !isJsonObject(item))) {
    throw protocolError(`${field} must be an array of objects`);
  }
  return value as JsonObject[];
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw protocolError(`${field} must be a non-empty string`);
  return value;
}

function requiredInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw protocolError(`${field} must be a non-negative integer`);
  return value as number;
}

function remoteRpcError(error: JsonObject): DocWenMachineError {
  const data = isJsonObject(error.data) ? error.data : {};
  const taskError = isJsonObject(data.task_error) ? data.task_error : null;
  const taskErrorCode = typeof taskError?.code === "string" ? taskError.code : undefined;
  const taskErrorMessage = typeof taskError?.message === "string" ? taskError.message : undefined;
  const remoteCode =
    taskErrorCode ?? (typeof data.code === "string" ? data.code : String(error.code ?? "unknown"));
  const message =
    taskErrorMessage ?? (typeof error.message === "string" ? error.message : "DocWen rejected the request.");
  return new DocWenMachineError(`docwen_machine_remote:${remoteCode}`, message, taskError ?? data);
}

function remoteTaskError(params: JsonObject): DocWenMachineError {
  const error = requiredObject(params.error, "task/failed.error");
  const code = typeof error.code === "string" ? error.code : "task_failed";
  const message = typeof error.message === "string" ? error.message : "DocWen task failed.";
  return new DocWenMachineError(`docwen_machine_remote:${code}`, message, error);
}

function protocolError(error: unknown): DocWenMachineError {
  return new DocWenMachineError("docwen_machine_protocol_error", errorMessage(error));
}

function integrityError(message: string): DocWenMachineError {
  return new DocWenMachineError("docwen_machine_integrity_error", message);
}

function outputLimitError(message: string, details: JsonObject): DocWenMachineError {
  return new DocWenMachineError("docwen_machine_output_limit", message, details);
}

function localError(code: string, message: string, cause: unknown): DocWenMachineError {
  return new DocWenMachineError(code, message, { cause: errorMessage(cause) });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function boundedEnvironment(locale?: string): NodeJS.ProcessEnv {
  const bootstrapKeys = ["SystemRoot", "WINDIR", "COMSPEC", "PATH", "PATHEXT", "TEMP", "TMP"];
  const env: NodeJS.ProcessEnv = {};
  for (const key of bootstrapKeys) if (process.env[key]) env[key] = process.env[key];
  for (const key of ["DOCWEN_CONFIG_DIR", "DOCWEN_LOG_DIR"] as const) {
    const value = process.env[key]?.trim();
    if (value && !value.includes("\u0000")) env[key] = value;
  }
  const logToTemp = process.env.DOCWEN_LOG_TO_TEMP?.trim().toLowerCase();
  if (logToTemp && ["1", "true", "yes", "on"].includes(logToTemp)) {
    env.DOCWEN_LOG_TO_TEMP = "1";
  }
  if (locale && locale !== "auto") env.LANG = locale;
  env.NO_COLOR = "1";
  env.PYTHONIOENCODING = "utf-8";
  env.PYTHONUTF8 = "1";
  return env;
}
