import { constants as fsConstants, createReadStream, type BigIntStats } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import type { DocWenPluginConfig } from "../config.js";
import {
  DocWenMachineError,
  type JsonObject,
  type MachineCapability,
  type MachineInputHandle,
  type MachineInputKind,
  type MachineInputRole,
  type MachineTaskCompleted,
  runDocWenMachineQuery,
  runDocWenMachineTask,
  type ValidatedArtifactBundle,
} from "./machine-client.js";
import { resolveDocWenBinary } from "./path.js";

const MARKDOWN_MEDIA_TYPE = "text/markdown";
const DOCX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PDF_MEDIA_TYPE = "application/pdf";
const CSV_MEDIA_TYPE = "text/csv";
const PNG_MEDIA_TYPE = "image/png";
const TIFF_MEDIA_TYPE = "image/tiff";
const JSON_MEDIA_TYPE = "application/json";
const RESOLVED_DOCUMENT_MEDIA_TYPE = "application/vnd.docwen.resolved-document+json";
const NUMBERING_EXPORT_PLAN_MEDIA_TYPE = "application/vnd.docwen.numbering-export-plan+json";
const MAX_REPORT_BYTES = 16 * 1024 * 1024;
const MACHINE_INPUT_ROLES: readonly MachineInputRole[] = [
  "source",
  "linked_resource",
  "bibliography",
  "citation_style",
  "neutral_document",
  "numbering_export_plan",
];

type Params = Record<string, unknown>;

type InputSpec = {
  file: string;
  kind: MachineInputKind;
  role: MachineInputRole;
  logicalPath: string;
};

type TaskExecution = {
  completed: MachineTaskCompleted;
  temporaryRoot: string;
};

type PathIdentity = Readonly<{
  dev: bigint;
  ino: bigint;
  mode: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}>;

type CommitTestHooks = Readonly<{
  beforeSwap?: () => Promise<void> | void;
  cleanupBackup?: (backup: string) => Promise<void>;
  onCleanupWarning?: (message: string) => void;
}>;

export async function executeDocWenTool(
  toolName: string,
  params: Params,
  config: DocWenPluginConfig,
  signal?: AbortSignal,
): Promise<unknown> {
  const binaryPath = await resolveDocWenBinary(config.binaryPath);
  switch (toolName) {
    case "docwen_info":
      return info(binaryPath, config, signal);
    case "docwen_inspect":
      return inspect(binaryPath, requiredString(params, "file"), config, signal);
    case "docwen_resources":
      return resources(binaryPath, params, config, signal);
    case "docwen_validate_markdown":
      return validateMarkdown(binaryPath, params, config, signal);
    case "docwen_convert":
      return convert(binaryPath, params, config, signal);
    case "docwen_number_markdown":
      return numberMarkdown(binaryPath, params, config, signal);
    case "docwen_merge_pdfs":
      return persistentTask(
        binaryPath,
        "merge.pdf.documents",
        requiredInputArray(params, "inputs"),
        {},
        params,
        config,
        signal,
      );
    case "docwen_split_pdf":
      return persistentTask(
        binaryPath,
        "split.pdf.partition",
        [sourceInput(requiredString(params, "file"))],
        { pages: parsePageSelection(requiredString(params, "pages")) },
        params,
        config,
        signal,
      );
    case "docwen_merge_tables":
      return persistentTask(
        binaryPath,
        "merge.xlsx.tables",
        requiredInputArray(params, "inputs"),
        {
          merge_mode: requiredEnum(params, "mode", ["row", "col", "cell"]),
          ...(params.offsetRange === undefined
            ? {}
            : { offset_range: requiredInteger(params, "offsetRange", 0, 50) }),
        },
        params,
        config,
        signal,
      );
    case "docwen_merge_images_to_tiff":
      return persistentTask(
        binaryPath,
        "merge.images.to_tiff",
        requiredInputArray(params, "inputs"),
        {
          keep_alpha: optionalBoolean(params, "keepAlpha") ?? true,
          mode: optionalEnum(params, "mode", ["smart", "rgb", "RGB"]) ?? "smart",
        },
        params,
        config,
        signal,
      );
    default:
      throw new DocWenMachineError("docwen_tool_unsupported", `Unsupported DocWen tool: ${toolName}`);
  }
}

async function info(
  binaryPath: string,
  config: DocWenPluginConfig,
  signal?: AbortSignal,
): Promise<JsonObject> {
  const [health, capabilities] = await Promise.all([
    query(binaryPath, "health/check", {}, config, signal),
    query(binaryPath, "capability/list", {}, config, signal),
  ]);
  return {
    machine_protocol: health.initialize.protocol,
    artifact_bundle_schema: health.initialize.artifact_bundle_schema,
    server: health.initialize.server,
    health: health.result,
    capabilities: capabilities.result.capabilities,
  };
}

async function inspect(
  binaryPath: string,
  file: string,
  config: DocWenPluginConfig,
  signal?: AbortSignal,
): Promise<JsonObject> {
  const input = (await buildInputHandles([sourceInput(file)]))[0]!;
  return (await query(binaryPath, "file/inspect", { input }, config, signal)).result;
}

async function resources(
  binaryPath: string,
  params: Params,
  config: DocWenPluginConfig,
  signal?: AbortSignal,
): Promise<JsonObject> {
  const queryParams: JsonObject = { kind: requiredString(params, "kind") };
  const target = optionalString(params, "target");
  if (target) queryParams.target = target;
  if (config.language && config.language !== "auto") queryParams.locale = config.language;
  const result = (await query(binaryPath, "resource/list", queryParams, config, signal)).result;
  if (result.kind !== queryParams.kind) {
    throw new DocWenMachineError(
      "docwen_machine_protocol_error",
      "Resource response kind does not match the request.",
    );
  }
  const items = objectArray(result.resources, "resource/list.resources");
  if (result.kind === "templates") validateTemplateResources(items, target);
  const requestedId = optionalString(params, "id");
  if (!requestedId) return result;
  const resource = items.find((item) => item.id === requestedId);
  if (!resource)
    throw new DocWenMachineError("docwen_resource_not_found", `Unknown DocWen resource: ${requestedId}`);
  return { kind: result.kind, resource };
}

function validateTemplateResources(items: JsonObject[], target?: string): void {
  const ids = new Set<string>();
  const defaults = new Set<string>();
  for (const item of items) {
    const id = item.id;
    const itemTarget = item.target;
    if (
      typeof id !== "string" ||
      !/^template\.(?:docx|xlsx)\.[0-9a-f]{64}$/u.test(id) ||
      (itemTarget !== "docx" && itemTarget !== "xlsx") ||
      !id.startsWith(`template.${itemTarget}.`) ||
      (target !== undefined && itemTarget !== target) ||
      typeof item.name !== "string" ||
      typeof item.description !== "string" ||
      (item.origin !== "builtin" && item.origin !== "custom") ||
      typeof item.is_default !== "boolean" ||
      ids.has(id) ||
      (item.is_default && defaults.has(itemTarget))
    ) {
      throw new DocWenMachineError(
        "docwen_machine_protocol_error",
        "Invalid or ambiguous template resource metadata.",
      );
    }
    ids.add(id);
    if (item.is_default) defaults.add(itemTarget);
  }
}

async function validateMarkdown(
  binaryPath: string,
  params: Params,
  config: DocWenPluginConfig,
  signal?: AbortSignal,
): Promise<JsonObject> {
  const options: JsonObject = {};
  const optionMap = {
    enableSymbolPairing: "enable_symbol_pairing",
    enableSymbolCorrection: "enable_symbol_correction",
    enableTyposRule: "enable_typos_rule",
    enableSensitiveWord: "enable_sensitive_word",
    skipCodeBlocks: "skip_code_blocks",
    skipQuoteBlocks: "skip_quote_blocks",
  } as const;
  for (const [parameter, option] of Object.entries(optionMap)) {
    const value = optionalBoolean(params, parameter);
    if (value !== undefined) options[option] = value;
  }
  const execution = await executeTask(
    binaryPath,
    "validate.markdown",
    [sourceInput(requiredString(params, "file"))],
    options,
    config,
    signal,
    true,
  );
  const warnings: string[] = [];
  try {
    const preferred = preferredArtifact(execution.completed.bundle);
    if (preferred.media_type !== JSON_MEDIA_TYPE || preferred.size_bytes > MAX_REPORT_BYTES) {
      throw new DocWenMachineError(
        "docwen_validation_report_invalid",
        "DocWen returned an invalid validation report.",
      );
    }
    let report: unknown;
    try {
      report = JSON.parse(await readFile(preferred.absolutePath, "utf8"));
    } catch (error) {
      throw new DocWenMachineError(
        "docwen_validation_report_invalid",
        "DocWen validation report is not valid JSON.",
        {
          cause: error instanceof Error ? error.message : String(error),
        },
      );
    }
    await cleanupTaskRoot(execution.temporaryRoot, warnings);
    return {
      capability_id: "validate.markdown",
      report: jsonValue(report),
      diagnostics: execution.completed.diagnostics,
      metrics: execution.completed.metrics,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  } catch (error) {
    await rm(execution.temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function convert(
  binaryPath: string,
  params: Params,
  config: DocWenPluginConfig,
  signal?: AbortSignal,
): Promise<JsonObject> {
  const inputs = requiredInputArray(params, "inputs");
  const preparedInputs = await buildInputHandles(inputs);
  const outputMediaType = targetMediaType(requiredString(params, "to"));
  const capabilities = await discoverCapabilities(binaryPath, config, signal);
  const matches = capabilities.filter(
    (capability) =>
      capability.availability !== "unavailable" &&
      ["convert", "render"].includes(capability.operation) &&
      capabilityAcceptsInputs(capability, preparedInputs) &&
      capability.output_media_types.includes(outputMediaType),
  );
  if (matches.length !== 1) {
    throw new DocWenMachineError(
      matches.length === 0 ? "docwen_capability_unavailable" : "docwen_capability_ambiguous",
      `No unique available DocWen conversion accepts the supplied typed inputs and produces ${outputMediaType}.`,
    );
  }
  const capability = matches[0]!;
  const options = buildConversionOptions(capability, params);
  return persistentTask(
    binaryPath,
    capability.capability_id,
    inputs,
    options,
    params,
    config,
    signal,
    preparedInputs,
    capability,
  );
}

function buildConversionOptions(capability: MachineCapability, params: Params): JsonObject {
  const options: JsonObject = {};
  const template = optionalString(params, "template");
  if (template) setSupportedOption(capability, options, ["template_name"], template, "template");

  const keepImages = optionalBoolean(params, "keepImages");
  if (keepImages !== undefined) {
    const mapped = setSupportedOption(
      capability,
      options,
      ["preserve_resources", "to_md_keep_images"],
      keepImages,
      "keepImages",
      false,
    );
    const imageMode = capabilityOptionSchema(capability, "image_mode");
    if (imageMode) {
      const requestedMode = keepImages ? "file" : "omit";
      if (optionAllowsValue(imageMode, requestedMode)) {
        options.image_mode = requestedMode;
      } else if (!mapped) {
        throw unsupportedCapabilityOption(capability, "keepImages");
      }
    } else if (!mapped) {
      throw unsupportedCapabilityOption(capability, "keepImages");
    }
  }

  const ocr = optionalBoolean(params, "ocr");
  if (ocr !== undefined) {
    setSupportedOption(capability, options, ["recognize_text", "to_md_enable_ocr"], ocr, "ocr");
  }

  const ocrLanguage = optionalString(params, "ocrLanguage");
  if (ocrLanguage) setSupportedOption(capability, options, ["ocr_language"], ocrLanguage, "ocrLanguage");

  const removeNumbering = optionalBoolean(params, "removeNumbering");
  if (removeNumbering !== undefined) {
    setSupportedOption(capability, options, ["remove_numbering"], removeNumbering, "removeNumbering");
  }

  const addNumbering = optionalBoolean(params, "addNumbering");
  if (addNumbering !== undefined) {
    setSupportedOption(capability, options, ["add_numbering"], addNumbering, "addNumbering");
  }

  const numberingScheme = optionalString(params, "numberingScheme");
  if (numberingScheme) {
    setSupportedOption(capability, options, ["numbering_scheme"], numberingScheme, "numberingScheme");
  }
  return options;
}

function setSupportedOption(
  capability: MachineCapability,
  options: JsonObject,
  names: readonly string[],
  value: string | boolean,
  parameter: string,
  required = true,
): boolean {
  const name = names.find((candidate) => capabilityOptionSchema(capability, candidate) !== undefined);
  if (!name) {
    if (required) throw unsupportedCapabilityOption(capability, parameter);
    return false;
  }
  options[name] = value;
  return true;
}

function capabilityOptionSchema(capability: MachineCapability, name: string): JsonObject | undefined {
  const properties = capability.options_schema.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return undefined;
  const schema = (properties as JsonObject)[name];
  return schema && typeof schema === "object" && !Array.isArray(schema) ? (schema as JsonObject) : undefined;
}

function optionAllowsValue(schema: JsonObject, value: string): boolean {
  const allowed = schema.enum;
  return !Array.isArray(allowed) || allowed.includes(value);
}

function unsupportedCapabilityOption(capability: MachineCapability, parameter: string): DocWenMachineError {
  return new DocWenMachineError(
    "docwen_option_unsupported",
    `The selected DocWen capability does not support the requested ${parameter} option: ${capability.capability_id}`,
  );
}

async function numberMarkdown(
  binaryPath: string,
  params: Params,
  config: DocWenPluginConfig,
  signal?: AbortSignal,
): Promise<JsonObject> {
  const operation = requiredEnum(params, "operation", ["add", "remove"]);
  const inPlace = optionalBoolean(params, "inPlace") ?? false;
  const hasOutputDir = params.outputDir !== undefined;
  if (inPlace === hasOutputDir) {
    throw new DocWenMachineError(
      "docwen_number_requires_one_output_mode",
      "Choose exactly one of inPlace=true or an explicit outputDir.",
    );
  }
  const scheme = optionalString(params, "scheme");
  if (operation === "remove" && scheme) {
    throw new DocWenMachineError(
      "docwen_number_remove_rejects_scheme",
      "Removing numbering does not accept a scheme.",
    );
  }
  const file = requiredString(params, "file");
  const input = sourceInput(file);
  const options: JsonObject = {
    remove_numbering: true,
    add_numbering: operation === "add",
  };
  if (scheme) options.numbering_scheme = scheme;
  if (!inPlace) {
    return persistentTask(
      binaryPath,
      "transform.markdown.heading_numbering",
      [input],
      options,
      params,
      config,
      signal,
    );
  }
  const preparedInputs = await buildInputHandles([input]);
  const sourceVersion = {
    sizeBytes: preparedInputs[0]!.size_bytes,
    sha256: preparedInputs[0]!.sha256,
  };
  const execution = await executeTask(
    binaryPath,
    "transform.markdown.heading_numbering",
    [input],
    options,
    config,
    signal,
    true,
    preparedInputs,
  );
  const warnings: string[] = [];
  try {
    const preferred = preferredArtifact(execution.completed.bundle);
    if (preferred.kind !== "document" || preferred.media_type !== MARKDOWN_MEDIA_TYPE) {
      throw new DocWenMachineError(
        "docwen_bundle_shape_invalid",
        "Numbering did not return one preferred Markdown document.",
      );
    }
    const committedPath = await atomicReplaceFile(
      file,
      preferred.absolutePath,
      {
        sizeBytes: preferred.size_bytes,
        sha256: preferred.sha256,
      },
      { onCleanupWarning: (warning) => warnings.push(warning) },
      sourceVersion,
    );
    await cleanupTaskRoot(execution.temporaryRoot, warnings);
    return taskResult(
      execution.completed,
      path.dirname(committedPath),
      [committedPath],
      committedPath,
      true,
      warnings,
    );
  } catch (error) {
    await rm(execution.temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function persistentTask(
  binaryPath: string,
  capabilityId: string,
  inputs: InputSpec[],
  options: JsonObject,
  params: Params,
  config: DocWenPluginConfig,
  signal?: AbortSignal,
  preparedInputs?: MachineInputHandle[],
  preparedCapability?: MachineCapability,
): Promise<JsonObject> {
  const outputDir = requiredAbsolutePath(params, "outputDir");
  const overwrite = optionalBoolean(params, "overwrite") ?? false;
  await preflightOutputDirectory(outputDir, overwrite);
  const execution = await executeTask(
    binaryPath,
    capabilityId,
    inputs,
    options,
    config,
    signal,
    true,
    preparedInputs,
    preparedCapability,
  );
  const warnings: string[] = [];
  try {
    const committed = await atomicCommitBundle(execution.completed.bundle, outputDir, overwrite, {
      onCleanupWarning: (warning) => warnings.push(warning),
    });
    await cleanupTaskRoot(execution.temporaryRoot, warnings);
    return taskResult(
      execution.completed,
      outputDir,
      committed.artifactPaths,
      committed.preferredArtifactPath,
      false,
      warnings,
    );
  } catch (error) {
    await rm(execution.temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function executeTask(
  binaryPath: string,
  capabilityId: string,
  inputSpecs: InputSpec[],
  options: JsonObject,
  config: DocWenPluginConfig,
  signal: AbortSignal | undefined,
  requireAvailable: boolean,
  preparedInputs?: MachineInputHandle[],
  preparedCapability?: MachineCapability,
): Promise<TaskExecution> {
  const inputs = preparedInputs ?? (await buildInputHandles(inputSpecs));
  if (requireAvailable) {
    const capability =
      preparedCapability?.capability_id === capabilityId
        ? preparedCapability
        : (await discoverCapabilities(binaryPath, config, signal)).find(
            (item) => item.capability_id === capabilityId,
          );
    if (!capability || capability.availability === "unavailable") {
      throw new DocWenMachineError(
        "docwen_capability_unavailable",
        `DocWen capability is unavailable: ${capabilityId}`,
      );
    }
    if (!capabilityAcceptsInputs(capability, inputs)) {
      throw new DocWenMachineError(
        "docwen_capability_input_unsupported",
        `DocWen capability does not accept the supplied typed inputs: ${capabilityId}`,
      );
    }
  }
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "docwen-openclaw-task-"));
  const stagingRoot = path.join(temporaryRoot, "output");
  await mkdir(stagingRoot);
  try {
    const completed = await runDocWenMachineTask({
      binaryPath,
      timeoutMs: config.writeTimeoutMs ?? 600_000,
      signal,
      locale: config.language,
      request: {
        capability_id: capabilityId,
        inputs,
        output: { staging_root: { kind: "local_path", path: stagingRoot }, staging_policy: "require_empty" },
        options,
      },
    });
    return { completed, temporaryRoot };
  } catch (error) {
    await rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function query(
  binaryPath: string,
  method: string,
  params: JsonObject,
  config: DocWenPluginConfig,
  signal?: AbortSignal,
): Promise<{ initialize: JsonObject; result: JsonObject }> {
  return runDocWenMachineQuery({
    binaryPath,
    method,
    params,
    timeoutMs: config.readTimeoutMs ?? 30_000,
    signal,
    locale: config.language,
  });
}

async function discoverCapabilities(
  binaryPath: string,
  config: DocWenPluginConfig,
  signal?: AbortSignal,
): Promise<MachineCapability[]> {
  const result = (await query(binaryPath, "capability/list", {}, config, signal)).result;
  return objectArray(result.capabilities, "capability/list.capabilities").map(parseCapability);
}

function parseCapability(value: JsonObject): MachineCapability {
  const capabilityId = requiredStringValue(value.capability_id, "capability.capability_id");
  const inputShape = requiredObject(value.input_shape, "capability.input_shape");
  assertOnlyProperties(inputShape, ["slots", "undeclared_roles"], "capability.input_shape");
  const shape = requiredObject(value.output_shape, "capability.output_shape");
  const availability = requiredEnumValue(value.availability, ["available", "limited", "unavailable"]);
  const cardinality = requiredEnumValue(shape.cardinality, ["one", "many"]);
  const artifactKinds: Array<"document" | "fragment" | "resource"> = stringArray(
    shape.artifact_kinds,
    "capability.output_shape.artifact_kinds",
  ).map((kind) => requiredEnumValue(kind, ["document", "fragment", "resource"]));
  if (shape.atomic_bundle !== true) {
    throw new DocWenMachineError(
      "docwen_machine_protocol_error",
      "Capability does not declare an atomic Bundle.",
    );
  }
  if (inputShape.undeclared_roles !== "reject") {
    throw new DocWenMachineError(
      "docwen_machine_protocol_error",
      "Capability must reject undeclared input roles.",
    );
  }
  const slots = objectArray(inputShape.slots, "capability.input_shape.slots").map((slot) => {
    assertOnlyProperties(
      slot,
      ["role", "kind", "media_types", "min_items", "max_items"],
      "capability.input_shape.slots",
    );
    const role = requiredEnumValue(slot.role, MACHINE_INPUT_ROLES);
    const kind = requiredEnumValue(slot.kind, ["document", "resource"]);
    const mediaTypes = stringArray(slot.media_types, "capability.input_shape.slots.media_types");
    const minItems = requiredNonNegativeIntegerValue(
      slot.min_items,
      "capability.input_shape.slots.min_items",
    );
    const maxItems =
      slot.max_items === undefined
        ? undefined
        : requiredNonNegativeIntegerValue(slot.max_items, "capability.input_shape.slots.max_items");
    if (!inputKindAcceptsRole(kind, role)) {
      throw new DocWenMachineError(
        "docwen_machine_protocol_error",
        "Capability input slot kind and role are incompatible.",
      );
    }
    if (mediaTypes.length === 0 || new Set(mediaTypes).size !== mediaTypes.length) {
      throw new DocWenMachineError(
        "docwen_machine_protocol_error",
        "Capability input slot media_types must be a non-empty unique array.",
      );
    }
    if (maxItems !== undefined && maxItems < minItems) {
      throw new DocWenMachineError(
        "docwen_machine_protocol_error",
        "Capability input slot max_items must not be below min_items.",
      );
    }
    return {
      role,
      kind,
      media_types: mediaTypes,
      min_items: minItems,
      ...(maxItems === undefined ? {} : { max_items: maxItems }),
    };
  });
  if (slots.length === 0 || new Set(slots.map((slot) => slot.role)).size !== slots.length) {
    throw new DocWenMachineError(
      "docwen_machine_protocol_error",
      "Capability input slot roles must be unique.",
    );
  }
  validateCapabilityInputContract(capabilityId, slots);
  return {
    capability_id: capabilityId,
    operation: requiredStringValue(value.operation, "capability.operation"),
    input_shape: { slots, undeclared_roles: "reject" },
    output_media_types: stringArray(value.output_media_types, "capability.output_media_types"),
    output_shape: {
      cardinality,
      artifact_kinds: artifactKinds,
      relation_types: stringArray(shape.relation_types, "capability.output_shape.relation_types"),
      atomic_bundle: true,
    },
    options_schema: requiredObject(value.options_schema, "capability.options_schema"),
    availability,
    dependencies: objectArray(value.dependencies, "capability.dependencies"),
    limitations: objectArray(value.limitations, "capability.limitations"),
  };
}

function validateCapabilityInputContract(
  capabilityId: string,
  slots: MachineCapability["input_shape"]["slots"],
): void {
  if (capabilityId !== "convert.markdown.to_docx") {
    const source = slots.find((slot) => slot.role === "source");
    if (!source || source.min_items < 1) {
      throw new DocWenMachineError(
        "docwen_machine_protocol_error",
        "Capability must declare at least one source input.",
      );
    }
    return;
  }

  const expected = new Map<MachineInputRole, { kind: MachineInputKind; mediaType: string }>([
    ["neutral_document", { kind: "document", mediaType: RESOLVED_DOCUMENT_MEDIA_TYPE }],
    ["numbering_export_plan", { kind: "resource", mediaType: NUMBERING_EXPORT_PLAN_MEDIA_TYPE }],
  ]);
  if (slots.length !== expected.size) {
    throw new DocWenMachineError(
      "docwen_machine_protocol_error",
      "convert.markdown.to_docx must declare exactly neutral_document and numbering_export_plan inputs.",
    );
  }
  for (const slot of slots) {
    const contract = expected.get(slot.role);
    if (
      contract === undefined ||
      slot.kind !== contract.kind ||
      slot.min_items !== 1 ||
      slot.max_items !== 1 ||
      slot.media_types.length !== 1 ||
      slot.media_types[0] !== contract.mediaType
    ) {
      throw new DocWenMachineError(
        "docwen_machine_protocol_error",
        "convert.markdown.to_docx capability input shape does not match the exact-two contract.",
      );
    }
  }
}

function capabilityAcceptsInputs(
  capability: MachineCapability,
  inputs: readonly MachineInputHandle[],
): boolean {
  const slots = new Map(capability.input_shape.slots.map((slot) => [slot.role, slot]));
  const counts = new Map<MachineInputRole, number>();
  for (const input of inputs) {
    const slot = slots.get(input.role);
    if (!slot || slot.kind !== input.kind || !slot.media_types.includes(input.media_type)) return false;
    counts.set(input.role, (counts.get(input.role) ?? 0) + 1);
  }
  return capability.input_shape.slots.every((slot) => {
    const count = counts.get(slot.role) ?? 0;
    return count >= slot.min_items && (slot.max_items === undefined || count <= slot.max_items);
  });
}

async function buildInputHandles(inputSpecs: readonly InputSpec[]): Promise<MachineInputHandle[]> {
  if (inputSpecs.length === 0)
    throw new DocWenMachineError("docwen_invalid_parameter", "At least one input is required.");
  const handles: MachineInputHandle[] = [];
  const canonicalPaths = new Set<string>();
  const logicalPaths = new Set<string>();
  for (const [index, input] of inputSpecs.entries()) {
    const file = input.file;
    validateInputKindRole(input.kind, input.role);
    const logicalPath = validateLogicalPath(input.logicalPath);
    if (logicalPaths.has(logicalPath)) {
      throw new DocWenMachineError("docwen_duplicate_logical_path", `Duplicate logical path: ${logicalPath}`);
    }
    logicalPaths.add(logicalPath);
    if (!path.isAbsolute(file))
      throw new DocWenMachineError("docwen_path_not_absolute", `Input path is not absolute: ${file}`);
    const fileInfo = await lstat(file);
    if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) {
      throw new DocWenMachineError("docwen_input_not_regular_file", `Input is not a regular file: ${file}`);
    }
    const canonicalPath = await realpath(file);
    const key = process.platform === "win32" ? canonicalPath.toLowerCase() : canonicalPath;
    if (canonicalPaths.has(key))
      throw new DocWenMachineError("docwen_duplicate_input", `Duplicate input: ${file}`);
    canonicalPaths.add(key);
    const metadata = await stat(canonicalPath);
    handles.push({
      input_id: `input.${index + 1}`,
      locator: { kind: "local_path", path: canonicalPath },
      kind: input.kind,
      role: input.role,
      logical_path: logicalPath,
      media_type: mediaTypeForInput(canonicalPath, input.role),
      size_bytes: metadata.size,
      sha256: await hashFile(canonicalPath),
    });
  }
  return handles;
}

function sourceInput(file: string): InputSpec {
  return {
    file,
    kind: isResourceMediaType(mediaTypeForPath(file)) ? "resource" : "document",
    role: "source",
    logicalPath: path.basename(file),
  };
}

function isResourceMediaType(mediaType: string): boolean {
  return mediaType.startsWith("image/");
}

function validateInputKindRole(kind: MachineInputKind, role: MachineInputRole): void {
  if (inputKindAcceptsRole(kind, role)) return;
  throw new DocWenMachineError(
    "docwen_invalid_input_role",
    kind === "document"
      ? `Document inputs cannot use the ${role} role.`
      : `${role} inputs cannot be resources.`,
  );
}

function inputKindAcceptsRole(kind: MachineInputKind, role: MachineInputRole): boolean {
  if (role === "source") return true;
  if (role === "neutral_document") return kind === "document";
  return kind === "resource";
}

function validateLogicalPath(value: string): string {
  if (
    value.length === 0 ||
    value.includes("\\") ||
    value.includes("\u0000") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/u.test(value) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value)
  ) {
    throw new DocWenMachineError(
      "docwen_invalid_logical_path",
      "logicalPath must be a relative POSIX virtual path.",
    );
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new DocWenMachineError("docwen_invalid_logical_path", "logicalPath contains an unsafe segment.");
  }
  return value;
}

async function hashFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(file);
    stream.on("data", (chunk: Buffer) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolve);
  });
  return hash.digest("hex");
}

function mediaTypeForPath(file: string): string {
  const mediaTypes: Record<string, string> = {
    ".md": MARKDOWN_MEDIA_TYPE,
    ".markdown": MARKDOWN_MEDIA_TYPE,
    ".docx": DOCX_MEDIA_TYPE,
    ".xlsx": XLSX_MEDIA_TYPE,
    ".pdf": PDF_MEDIA_TYPE,
    ".csv": CSV_MEDIA_TYPE,
    ".png": PNG_MEDIA_TYPE,
    ".tif": TIFF_MEDIA_TYPE,
    ".tiff": TIFF_MEDIA_TYPE,
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".bmp": "image/bmp",
    ".webp": "image/webp",
  };
  const mediaType = mediaTypes[path.extname(file).toLowerCase()];
  if (!mediaType)
    throw new DocWenMachineError("docwen_media_type_unknown", `Unsupported input extension: ${file}`);
  return mediaType;
}

function mediaTypeForInput(file: string, role: MachineInputRole): string {
  if (role === "neutral_document") return RESOLVED_DOCUMENT_MEDIA_TYPE;
  if (role === "numbering_export_plan") return NUMBERING_EXPORT_PLAN_MEDIA_TYPE;
  return mediaTypeForPath(file);
}

function targetMediaType(target: string): string {
  const mediaTypes: Record<string, string> = {
    md: MARKDOWN_MEDIA_TYPE,
    markdown: MARKDOWN_MEDIA_TYPE,
    docx: DOCX_MEDIA_TYPE,
    xlsx: XLSX_MEDIA_TYPE,
    csv: CSV_MEDIA_TYPE,
    png: PNG_MEDIA_TYPE,
  };
  const normalized = target.toLowerCase().replace(/^\./u, "");
  const mediaType = mediaTypes[normalized];
  if (!mediaType)
    throw new DocWenMachineError("docwen_target_unsupported", `Unsupported conversion target: ${target}`);
  return mediaType;
}

function parsePageSelection(value: string): number[] {
  if (!/^[0-9,-]+$/u.test(value)) {
    throw new DocWenMachineError(
      "docwen_invalid_pages",
      "PDF pages must contain only numbers, commas, and ranges.",
    );
  }
  const pages: number[] = [];
  const seen = new Set<number>();
  for (const part of value.split(",")) {
    const match = /^(\d+)(?:-(\d+))?$/u.exec(part);
    if (!match) throw new DocWenMachineError("docwen_invalid_pages", `Invalid PDF page selection: ${part}`);
    const start = Number(match[1]);
    const end = match[2] ? Number(match[2]) : start;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 1 ||
      end < start ||
      end - start > 100_000
    ) {
      throw new DocWenMachineError("docwen_invalid_pages", `Invalid PDF page range: ${part}`);
    }
    for (let page = start; page <= end; page += 1) {
      if (seen.has(page))
        throw new DocWenMachineError("docwen_invalid_pages", `PDF page is selected twice: ${page}`);
      seen.add(page);
      pages.push(page);
    }
  }
  return pages;
}

async function preflightOutputDirectory(
  destination: string,
  overwrite: boolean,
): Promise<PathIdentity | null> {
  assertSafeDestination(destination);
  try {
    const existing = await lstat(destination, { bigint: true });
    if (!existing.isDirectory() || existing.isSymbolicLink()) {
      throw new DocWenMachineError("docwen_output_not_directory", "Bundle output must be a real directory.");
    }
    if (!overwrite) {
      throw new DocWenMachineError(
        "docwen_output_exists",
        "Bundle output directory already exists; set overwrite=true explicitly.",
      );
    }
    return pathIdentity(existing);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

async function atomicCommitBundle(
  bundle: ValidatedArtifactBundle,
  destination: string,
  overwrite: boolean,
  hooks: CommitTestHooks = {},
): Promise<{ artifactPaths: string[]; preferredArtifactPath: string }> {
  assertSafeDestination(destination);
  const parent = path.dirname(destination);
  await mkdir(parent, { recursive: true });
  return withDestinationLock(
    destination,
    async () => {
      const expectedDestination = await preflightOutputDirectory(destination, overwrite);
      const transactionRoot = await mkdtemp(path.join(parent, `.docwen-${path.basename(destination)}-`));
      const backup = `${destination}.docwen-backup-${randomUUID()}`;
      const preferred = preferredArtifact(bundle);
      let movedExisting = false;
      let destinationCommitted = false;
      const artifactPaths: string[] = [];
      try {
        for (const artifact of bundle.artifacts) {
          const commitPath = artifactCommitPath(bundle, artifact);
          const target = path.join(transactionRoot, ...commitPath.split("/"));
          await mkdir(path.dirname(target), { recursive: true });
          await copyFile(artifact.absolutePath, target, fsConstants.COPYFILE_EXCL);
          await assertCopiedArtifact(target, artifact.size_bytes, artifact.sha256);
          artifactPaths.push(path.join(destination, ...commitPath.split("/")));
        }
        const manifestPath = path.join(transactionRoot, ".docwen-artifact-bundle.json");
        if (
          bundle.artifacts.some(
            (artifact) => artifactCommitPath(bundle, artifact) === ".docwen-artifact-bundle.json",
          )
        ) {
          throw new DocWenMachineError(
            "docwen_bundle_locator_reserved",
            "Bundle uses the consumer manifest locator.",
          );
        }
        await writeFile(manifestPath, `${JSON.stringify(serializableBundle(bundle), null, 2)}\n`, {
          encoding: "utf8",
          flag: "wx",
        });
        await hooks.beforeSwap?.();
        if (expectedDestination) {
          await assertPathIdentityUnchanged(destination, expectedDestination);
          await rename(destination, backup);
          movedExisting = true;
        } else {
          await assertPathStillAbsent(destination);
        }
        await rename(transactionRoot, destination);
        destinationCommitted = true;
      } catch (error) {
        if (movedExisting && !destinationCommitted) {
          try {
            await rename(backup, destination);
          } catch {
            throw new DocWenMachineError(
              "docwen_commit_rollback_failed",
              "Bundle commit and rollback both failed.",
              {
                cause: error instanceof Error ? error.message : String(error),
                backup,
              },
            );
          }
        }
        throw error;
      } finally {
        if (!destinationCommitted) {
          await rm(transactionRoot, { recursive: true, force: true }).catch(() => undefined);
        }
      }

      if (movedExisting) {
        try {
          if (hooks.cleanupBackup) await hooks.cleanupBackup(backup);
          else await rm(backup, { recursive: true, force: true });
        } catch (error) {
          hooks.onCleanupWarning?.(
            `The new Bundle was committed, but the previous output backup could not be removed: ${errorMessage(error)}`,
          );
        }
      }
      return {
        artifactPaths,
        preferredArtifactPath: path.join(destination, ...artifactCommitPath(bundle, preferred).split("/")),
      };
    },
    hooks.onCleanupWarning,
  );
}

async function atomicReplaceFile(
  destination: string,
  replacement: string,
  expected: { sizeBytes: number; sha256: string },
  hooks: CommitTestHooks = {},
  expectedSource?: { sizeBytes: number; sha256: string },
): Promise<string> {
  if (!path.isAbsolute(destination)) {
    throw new DocWenMachineError("docwen_path_not_absolute", "Input path is not absolute.");
  }
  return withDestinationLock(
    destination,
    async () => {
      const existing = await lstat(destination, { bigint: true });
      if (!existing.isFile() || existing.isSymbolicLink()) {
        throw new DocWenMachineError(
          "docwen_input_not_regular_file",
          "In-place target is not a regular file.",
        );
      }
      const expectedDestination = expectedSource
        ? await assertSourceVersionUnchanged(destination, existing, expectedSource)
        : pathIdentity(existing);
      const temporary = `${destination}.docwen-replacement-${randomUUID()}`;
      const backup = `${destination}.docwen-backup-${randomUUID()}`;
      await copyFile(replacement, temporary, fsConstants.COPYFILE_EXCL);
      await assertCopiedArtifact(temporary, expected.sizeBytes, expected.sha256);
      await chmod(temporary, Number(existing.mode));
      let movedExisting = false;
      let destinationCommitted = false;
      try {
        await hooks.beforeSwap?.();
        await assertPathIdentityUnchanged(destination, expectedDestination);
        await rename(destination, backup);
        movedExisting = true;
        await rename(temporary, destination);
        destinationCommitted = true;
      } catch (error) {
        if (movedExisting && !destinationCommitted) {
          try {
            await rename(backup, destination);
          } catch {
            throw new DocWenMachineError(
              "docwen_commit_rollback_failed",
              "In-place commit and rollback both failed.",
              {
                cause: error instanceof Error ? error.message : String(error),
                backup,
              },
            );
          }
        }
        throw error;
      } finally {
        if (!destinationCommitted) await rm(temporary, { force: true }).catch(() => undefined);
      }

      if (movedExisting) {
        try {
          if (hooks.cleanupBackup) await hooks.cleanupBackup(backup);
          else await rm(backup, { force: true });
        } catch (error) {
          hooks.onCleanupWarning?.(
            `The replacement was committed, but the previous file backup could not be removed: ${errorMessage(error)}`,
          );
        }
      }
      return destination;
    },
    hooks.onCleanupWarning,
  );
}

async function withDestinationLock<T>(
  destination: string,
  body: () => Promise<T>,
  onCleanupWarning?: (message: string) => void,
): Promise<T> {
  const lockPath = `${destination}.docwen-lock`;
  const lock = await acquireDestinationLock(lockPath);
  const expectedLock = pathIdentity(await lock.stat({ bigint: true }));
  let bodyResult: T | undefined;
  let bodyFailure: unknown;
  try {
    bodyResult = await body();
  } catch (error) {
    bodyFailure = error;
  }

  let cleanupFailure: unknown;
  try {
    const currentLock = await lstat(lockPath, { bigint: true });
    if (!samePathIdentity(currentLock, expectedLock)) {
      throw new DocWenMachineError("docwen_output_lock_lost", "The DocWen output lock changed unexpectedly.");
    }
    await lock.close();
    await rm(lockPath);
  } catch (error) {
    await lock.close().catch(() => undefined);
    cleanupFailure = error;
  }

  if (bodyFailure) {
    if (cleanupFailure) {
      throw new DocWenMachineError(
        "docwen_output_lock_lost",
        "The DocWen write failed and its output lock could not be cleaned up safely.",
        {
          cause: errorMessage(bodyFailure),
          lock_cleanup: errorMessage(cleanupFailure),
        },
      );
    }
    throw bodyFailure;
  }
  if (cleanupFailure) {
    onCleanupWarning?.(
      `The operation succeeded, but its output lock could not be removed: ${errorMessage(cleanupFailure)}`,
    );
  }
  return bodyResult as T;
}

async function acquireDestinationLock(lockPath: string) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const lock = await open(lockPath, "wx", 0o600);
      await lock.writeFile(
        `${JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() })}\n`,
        "utf8",
      );
      return lock;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      if (attempt === 0 && (await removeDeadOwnerLock(lockPath))) continue;
      throw new DocWenMachineError(
        "docwen_output_busy",
        "Another DocWen write is already targeting this path.",
      );
    }
  }
  throw new DocWenMachineError("docwen_output_busy", "Another DocWen write is already targeting this path.");
}

async function removeDeadOwnerLock(lockPath: string): Promise<boolean> {
  let before: BigIntStats;
  let payload: unknown;
  try {
    before = await lstat(lockPath, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink()) return false;
    payload = JSON.parse(await readFile(lockPath, "utf8"));
  } catch {
    return false;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const pid = (payload as Record<string, unknown>).pid;
  if (!Number.isSafeInteger(pid) || (pid as number) <= 0 || processIsAlive(pid as number)) return false;
  try {
    const after = await lstat(lockPath, { bigint: true });
    if (!samePathIdentity(after, pathIdentity(before))) return false;
    await rm(lockPath);
    return true;
  } catch {
    return false;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isErrno(error, "ESRCH");
  }
}

async function assertPathStillAbsent(destination: string): Promise<void> {
  try {
    await lstat(destination);
    throw new DocWenMachineError("docwen_output_exists", "Bundle output appeared during commit.");
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
}

async function assertPathIdentityUnchanged(destination: string, expected: PathIdentity): Promise<void> {
  let current: BigIntStats;
  try {
    current = await lstat(destination, { bigint: true });
  } catch (error) {
    if (isNotFound(error)) {
      throw new DocWenMachineError("docwen_output_changed", "The output target disappeared during commit.");
    }
    throw error;
  }
  if (!samePathIdentity(current, expected)) {
    throw new DocWenMachineError("docwen_output_changed", "The output target changed during commit.");
  }
}

async function assertSourceVersionUnchanged(
  destination: string,
  before: BigIntStats,
  expected: { sizeBytes: number; sha256: string },
): Promise<PathIdentity> {
  if (before.size !== BigInt(expected.sizeBytes)) {
    throw new DocWenMachineError(
      "docwen_source_changed",
      "The source file changed while DocWen was preparing the in-place result.",
    );
  }
  const digest = await hashFile(destination);
  const after = await lstat(destination, { bigint: true });
  if (!samePathIdentity(after, pathIdentity(before)) || digest !== expected.sha256) {
    throw new DocWenMachineError(
      "docwen_source_changed",
      "The source file changed while DocWen was preparing the in-place result.",
    );
  }
  return pathIdentity(after);
}

async function assertCopiedArtifact(
  file: string,
  expectedSize: number,
  expectedSha256: string,
): Promise<void> {
  const before = await lstat(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.size !== BigInt(expectedSize)) {
    throw new DocWenMachineError(
      "docwen_machine_integrity_error",
      "Copied artifact does not match its validated size.",
    );
  }
  const digest = await hashFile(file);
  const after = await lstat(file, { bigint: true });
  if (!samePathIdentity(after, pathIdentity(before)) || digest !== expectedSha256) {
    throw new DocWenMachineError(
      "docwen_machine_integrity_error",
      "Copied artifact does not match its validated identity.",
    );
  }
}

function pathIdentity(metadata: BigIntStats): PathIdentity {
  return {
    dev: metadata.dev,
    ino: metadata.ino,
    mode: metadata.mode,
    size: metadata.size,
    mtimeNs: metadata.mtimeNs,
    ctimeNs: metadata.ctimeNs,
  };
}

function samePathIdentity(metadata: BigIntStats, expected: PathIdentity): boolean {
  return (
    metadata.dev === expected.dev &&
    metadata.ino === expected.ino &&
    metadata.mode === expected.mode &&
    metadata.size === expected.size &&
    metadata.mtimeNs === expected.mtimeNs &&
    metadata.ctimeNs === expected.ctimeNs
  );
}

function serializableBundle(bundle: ValidatedArtifactBundle): JsonObject {
  return {
    schema: bundle.schema,
    bundle_id: bundle.bundle_id,
    task_id: bundle.task_id,
    producer: bundle.producer,
    ...(bundle.layout_schema === undefined ? {} : { layout_schema: bundle.layout_schema }),
    artifacts: bundle.artifacts.map((artifact) => ({
      artifact_id: artifact.artifact_id,
      kind: artifact.kind,
      locator: artifact.locator,
      ...(artifact.logical_path === undefined ? {} : { logical_path: artifact.logical_path }),
      suggested_name: artifact.suggested_name,
      media_type: artifact.media_type,
      size_bytes: artifact.size_bytes,
      sha256: artifact.sha256,
    })),
    entries: bundle.entries,
    relations: bundle.relations,
  };
}

function artifactCommitPath(
  bundle: ValidatedArtifactBundle,
  artifact: ValidatedArtifactBundle["artifacts"][number],
): string {
  if (bundle.schema === "docwen.artifact_bundle.v2") {
    if (artifact.logical_path === undefined) {
      throw new DocWenMachineError(
        "docwen_bundle_shape_invalid",
        "Artifact Bundle v2 is missing a validated logical path.",
      );
    }
    return artifact.logical_path;
  }
  return artifact.locator;
}

function preferredArtifact(bundle: ValidatedArtifactBundle) {
  const entry = bundle.entries.find((item) => item.preferred === true);
  const artifactId = entry && typeof entry.artifact_id === "string" ? entry.artifact_id : "";
  const artifact = bundle.artifacts.find((item) => item.artifact_id === artifactId);
  if (!artifact)
    throw new DocWenMachineError("docwen_bundle_shape_invalid", "Bundle preferred entry is invalid.");
  return artifact;
}

function taskResult(
  completed: MachineTaskCompleted,
  outputRoot: string,
  artifactPaths: string[],
  preferredArtifactPath: string,
  inPlace: boolean,
  warnings: readonly string[] = [],
): JsonObject {
  return {
    task_id: completed.taskId,
    capability_id: completed.plan.capability_id,
    output: {
      root: outputRoot,
      preferred_artifact: preferredArtifactPath,
      artifacts: artifactPaths,
      in_place: inPlace,
    },
    bundle: serializableBundle(completed.bundle),
    diagnostics: completed.diagnostics,
    metrics: completed.metrics,
    ...(warnings.length > 0 ? { warnings: [...warnings] } : {}),
  };
}

async function cleanupTaskRoot(temporaryRoot: string, warnings: string[]): Promise<void> {
  try {
    await rm(temporaryRoot, { recursive: true, force: true });
  } catch (error) {
    warnings.push(`The task completed, but its temporary files could not be removed: ${errorMessage(error)}`);
  }
}

function assertSafeDestination(destination: string): void {
  if (!path.isAbsolute(destination)) {
    throw new DocWenMachineError("docwen_path_not_absolute", "Bundle output directory must be absolute.");
  }
  const resolved = path.resolve(destination);
  if (resolved === path.parse(resolved).root) {
    throw new DocWenMachineError(
      "docwen_output_too_broad",
      "A filesystem root cannot be a Bundle output directory.",
    );
  }
}

function requiredAbsolutePath(params: Params, key: string): string {
  const value = requiredString(params, key);
  if (!path.isAbsolute(value))
    throw new DocWenMachineError("docwen_path_not_absolute", `${key} must be absolute.`);
  return path.resolve(value);
}

function requiredString(params: Params, key: string): string {
  return requiredStringValue(params[key], key);
}

function requiredStringValue(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new DocWenMachineError("docwen_invalid_parameter", `${field} must be a non-empty string.`);
  }
  return value;
}

function optionalString(params: Params, key: string): string | undefined {
  return params[key] === undefined ? undefined : requiredString(params, key);
}

function requiredInputArray(params: Params, key: string): InputSpec[] {
  const value = params[key];
  if (!Array.isArray(value) || value.length === 0) {
    throw new DocWenMachineError("docwen_invalid_parameter", `${key} must be a non-empty typed input array.`);
  }
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new DocWenMachineError("docwen_invalid_parameter", `${key}[${index}] must be an object.`);
    }
    const record = item as Record<string, unknown>;
    if (Object.keys(record).some((property) => !["file", "kind", "role", "logicalPath"].includes(property))) {
      throw new DocWenMachineError(
        "docwen_invalid_parameter",
        `${key}[${index}] contains an unsupported property.`,
      );
    }
    return {
      file: requiredStringValue(record.file, `${key}[${index}].file`),
      kind: requiredEnumValue(record.kind, ["document", "resource"]),
      role: requiredEnumValue(record.role, MACHINE_INPUT_ROLES),
      logicalPath: requiredStringValue(record.logicalPath, `${key}[${index}].logicalPath`),
    };
  });
}

function optionalBoolean(params: Params, key: string): boolean | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean")
    throw new DocWenMachineError("docwen_invalid_parameter", `${key} must be boolean.`);
  return value;
}

function requiredInteger(params: Params, key: string, minimum: number, maximum: number): number {
  const value = params[key];
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new DocWenMachineError(
      "docwen_invalid_parameter",
      `${key} must be an integer from ${minimum} to ${maximum}.`,
    );
  }
  return value as number;
}

function requiredEnum<T extends string>(params: Params, key: string, values: readonly T[]): T {
  return requiredEnumValue(params[key], values);
}

function optionalEnum<T extends string>(params: Params, key: string, values: readonly T[]): T | undefined {
  return params[key] === undefined ? undefined : requiredEnumValue(params[key], values);
}

function requiredEnumValue<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== "string" || !(values as readonly string[]).includes(value)) {
    throw new DocWenMachineError("docwen_invalid_parameter", `Expected one of: ${values.join(", ")}.`);
  }
  return value as T;
}

function requiredNonNegativeIntegerValue(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new DocWenMachineError("docwen_machine_protocol_error", `${field} must be a non-negative integer.`);
  }
  return value as number;
}

function requiredObject(value: unknown, field: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DocWenMachineError("docwen_machine_protocol_error", `${field} must be an object.`);
  }
  return value as JsonObject;
}

function assertOnlyProperties(value: JsonObject, allowed: readonly string[], field: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new DocWenMachineError(
      "docwen_machine_protocol_error",
      `${field} contains an unsupported property.`,
    );
  }
}

function objectArray(value: unknown, field: string): JsonObject[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => !item || typeof item !== "object" || Array.isArray(item))
  ) {
    throw new DocWenMachineError("docwen_machine_protocol_error", `${field} must be an object array.`);
  }
  return value as JsonObject[];
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new DocWenMachineError("docwen_machine_protocol_error", `${field} must be a string array.`);
  }
  return [...value];
}

function jsonValue(value: unknown): JsonObject | string | number | boolean | null | unknown[] {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
    return value as string | number | boolean | null;
  }
  if (Array.isArray(value)) return value.map(jsonValue);
  return requiredObject(value, "JSON value");
}

function isErrno(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function isAlreadyExists(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "EEXIST");
}

export const clientTesting = {
  atomicCommitBundle,
  atomicReplaceFile,
  buildConversionOptions,
  buildInputHandles,
  capabilityAcceptsInputs,
  parsePageSelection,
  parseCapability,
  requiredInputArray,
  validateLogicalPath,
  validateTemplateResources,
};
