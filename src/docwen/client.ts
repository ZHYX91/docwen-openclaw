import { lstat, mkdir, mkdtemp, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import type { DocWenPluginConfig } from "../config.js";
import { WRITE_TOOL_NAMES } from "../tools/catalog.js";
import {
  DocWenMachineError,
  type JsonObject,
  type MachineCapability,
  type MachineInputHandle,
  type MachineInputKind,
  type MachineInputRole,
  type MachineTaskCompleted,
  runDocWenMachineQuery,
  runDocWenMachineQueries,
  runDocWenMachineTask,
  type ValidatedArtifactBundle,
} from "./machine-client.js";
import { resolveDocWenBinary } from "./path.js";
import { diagnosticSummary } from "./diagnostics.js";
import {
  atomicCommitBundle,
  atomicReplaceFile,
  preflightOutputDirectory,
  preferredArtifact,
} from "./output-transaction.js";
import { hashFile, pathIdentity, samePathIdentity } from "./file-integrity.js";
import {
  cleanupPublicationPath,
  newPublication,
  OutputPublicationError,
  publicationFailure,
  publicationResult,
  type Publication,
} from "./publication.js";

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

type CapabilitySelection =
  | string
  | ((
      capabilities: MachineCapability[],
      inputs: MachineInputHandle[],
    ) => {
      capability: MachineCapability;
      options: JsonObject;
    });

export async function executeDocWenTool(
  toolName: string,
  params: Params,
  config: DocWenPluginConfig,
  signal?: AbortSignal,
): Promise<unknown> {
  try {
    return await executeTool(toolName, params, config, signal);
  } catch (error) {
    const writes = WRITE_TOOL_NAMES.some((name) => name === toolName);
    const publication = writes
      ? error instanceof OutputPublicationError
        ? error.publication
        : newPublication()
      : undefined;
    const failure = publication
      ? publicationFailure(error, publication)
      : error instanceof DocWenMachineError
        ? error
        : new DocWenMachineError(
            "docwen_operation_failed",
            error instanceof Error ? error.message : String(error),
          );
    return {
      ...(publication ? publicationResult(publication) : { status: "failed" }),
      error: { code: failure.code, message: failure.message },
      diagnostic_summary: diagnosticSummary({
        error: error ?? new Error("Unknown DocWen failure."),
        publication,
        warnings: error instanceof OutputPublicationError ? error.publication.warnings : undefined,
      }),
      ...(!writes && error instanceof OutputPublicationError && error.publication.warnings.length > 0
        ? { warnings: error.publication.warnings }
        : {}),
    };
  }
}

async function executeTool(
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
  const {
    initialize,
    results: [health, capabilities],
  } = await runDocWenMachineQueries({
    binaryPath,
    queries: [
      { method: "health/check", params: {} },
      { method: "capability/list", params: {} },
    ],
    timeoutMs: config.readTimeoutMs ?? 30_000,
    signal,
    locale: config.language,
  });
  return {
    machine_protocol: initialize.protocol,
    artifact_bundle_schema: initialize.artifact_bundle_schema,
    server: initialize.server,
    health: health!,
    capabilities: capabilities!.capabilities,
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
  if (
    result.kind !== queryParams.kind ||
    Object.keys(result).some((key) => !["kind", "resources"].includes(key))
  ) {
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
      Object.keys(item).some(
        (key) => !["id", "name", "description", "target", "origin", "is_default"].includes(key),
      ) ||
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
  );
  const cleanup = newPublication();
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
    await cleanupPublicationPath(execution.temporaryRoot, cleanup, "staging_cleanup_failed");
    return {
      capability_id: "validate.markdown",
      report: jsonValue(report),
      diagnostics: execution.completed.diagnostics,
      metrics: execution.completed.metrics,
      diagnostic_summary: diagnosticSummary({
        diagnosticCount: execution.completed.diagnostics.length,
        warnings: cleanup.warnings,
      }),
      ...(cleanup.warnings.length > 0 ? { warnings: cleanup.warnings } : {}),
    };
  } catch (error) {
    await cleanupPublicationPath(execution.temporaryRoot, cleanup, "staging_cleanup_failed");
    throw publicationFailure(error, cleanup);
  }
}

async function convert(
  binaryPath: string,
  params: Params,
  config: DocWenPluginConfig,
  signal?: AbortSignal,
): Promise<JsonObject> {
  const inputs = requiredInputArray(params, "inputs");
  const outputMediaType = targetMediaType(requiredString(params, "to"));
  const optimizationId = optionalString(params, "optimization");
  return persistentTask(
    binaryPath,
    (capabilities, preparedInputs) => {
      const capability = selectConversionCapability(
        capabilities,
        preparedInputs,
        outputMediaType,
        optimizationId,
      );
      return { capability, options: buildConversionOptions(capability, params) };
    },
    inputs,
    {},
    params,
    config,
    signal,
  );
}

function selectConversionCapability(
  capabilities: MachineCapability[],
  inputs: MachineInputHandle[],
  outputMediaType: string,
  optimizationId?: string,
): MachineCapability {
  const matches = capabilities.filter(
    (capability) =>
      capability.availability !== "unavailable" &&
      (optimizationId
        ? capability.operation === "transform" && capability.optimization_id === optimizationId
        : capability.optimization_id === undefined && ["convert", "render"].includes(capability.operation)) &&
      capabilityAcceptsInputs(capability, inputs) &&
      capability.output_media_types.includes(outputMediaType),
  );
  if (matches.length !== 1) {
    throw new DocWenMachineError(
      matches.length === 0 ? "docwen_capability_unavailable" : "docwen_capability_ambiguous",
      `No unique available DocWen conversion accepts the supplied typed inputs and produces ${outputMediaType}${optimizationId ? ` with optimization ${optimizationId}` : ""}.`,
    );
  }
  return matches[0]!;
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
  const schema = capabilityOptionSchema(capability, name)!;
  if (!optionAllowsValue(schema, value)) throw unsupportedCapabilityOption(capability, parameter);
  options[name] = value;
  return true;
}

function capabilityOptionSchema(capability: MachineCapability, name: string): JsonObject | undefined {
  const properties = capability.options_schema.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return undefined;
  const schema = (properties as JsonObject)[name];
  return schema && typeof schema === "object" && !Array.isArray(schema) ? (schema as JsonObject) : undefined;
}

function optionAllowsValue(schema: JsonObject, value: string | boolean): boolean {
  const type = schema.type;
  if (type !== undefined && (Array.isArray(type) ? !type.includes(typeof value) : type !== typeof value)) {
    return false;
  }
  if (Object.hasOwn(schema, "const") && schema.const !== value) return false;
  const allowed = schema.enum;
  return allowed === undefined || (Array.isArray(allowed) && allowed.includes(value));
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
    preparedInputs,
  );
  try {
    const preferred = preferredArtifact(execution.completed.bundle);
    if (preferred.kind !== "document" || preferred.media_type !== MARKDOWN_MEDIA_TYPE) {
      throw new DocWenMachineError(
        "docwen_bundle_shape_invalid",
        "Numbering did not return one preferred Markdown document.",
      );
    }
    const committed = await atomicReplaceFile(
      file,
      preferred.absolutePath,
      {
        sizeBytes: preferred.size_bytes,
        sha256: preferred.sha256,
      },
      { signal },
      sourceVersion,
    );
    await cleanupPublicationPath(execution.temporaryRoot, committed.publication, "staging_cleanup_failed");
    return taskResult(
      execution.completed,
      path.dirname(committed.value),
      [committed.value],
      committed.value,
      true,
      committed.publication,
    );
  } catch (error) {
    const publication = error instanceof OutputPublicationError ? error.publication : newPublication();
    await cleanupPublicationPath(execution.temporaryRoot, publication, "staging_cleanup_failed");
    throw publicationFailure(error, publication);
  }
}

async function persistentTask(
  binaryPath: string,
  selection: CapabilitySelection,
  inputs: InputSpec[],
  options: JsonObject,
  params: Params,
  config: DocWenPluginConfig,
  signal?: AbortSignal,
  preparedInputs?: MachineInputHandle[],
): Promise<JsonObject> {
  const outputDir = requiredAbsolutePath(params, "outputDir");
  const overwrite = optionalBoolean(params, "overwrite") ?? false;
  const initialDestination = await preflightOutputDirectory(outputDir, overwrite);
  const execution = await executeTask(binaryPath, selection, inputs, options, config, signal, preparedInputs);
  try {
    const committed = await atomicCommitBundle(
      execution.completed.bundle,
      outputDir,
      overwrite,
      { signal },
      initialDestination,
    );
    await cleanupPublicationPath(execution.temporaryRoot, committed.publication, "staging_cleanup_failed");
    return taskResult(
      execution.completed,
      outputDir,
      committed.value.artifactPaths,
      committed.value.preferredArtifactPath,
      false,
      committed.publication,
    );
  } catch (error) {
    const publication = error instanceof OutputPublicationError ? error.publication : newPublication();
    await cleanupPublicationPath(execution.temporaryRoot, publication, "staging_cleanup_failed");
    throw publicationFailure(error, publication);
  }
}

async function executeTask(
  binaryPath: string,
  selection: CapabilitySelection,
  inputSpecs: InputSpec[],
  options: JsonObject,
  config: DocWenPluginConfig,
  signal: AbortSignal | undefined,
  preparedInputs?: MachineInputHandle[],
): Promise<TaskExecution> {
  const inputs = preparedInputs ?? (await buildInputHandles(inputSpecs));
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "docwen-openclaw-task-"));
  const stagingRoot = path.join(temporaryRoot, "output");
  try {
    await mkdir(stagingRoot);
    const completed = await runDocWenMachineTask({
      binaryPath,
      timeoutMs: config.writeTimeoutMs ?? 600_000,
      readTimeoutMs: config.readTimeoutMs ?? 30_000,
      signal,
      locale: config.language,
      request: async (query) => {
        const result = await query("capability/list", {});
        const capabilities = objectArray(result.capabilities, "capability/list.capabilities").map(
          parseCapability,
        );
        const selected =
          typeof selection === "function"
            ? selection(capabilities, inputs)
            : { capability: capabilities.find((item) => item.capability_id === selection), options };
        const capability = selected.capability;
        if (!capability || capability.availability === "unavailable") {
          throw new DocWenMachineError(
            "docwen_capability_unavailable",
            `DocWen capability is unavailable: ${selection}`,
          );
        }
        if (!capabilityAcceptsInputs(capability, inputs)) {
          throw new DocWenMachineError(
            "docwen_capability_input_unsupported",
            `DocWen capability does not accept the supplied typed inputs: ${capability.capability_id}`,
          );
        }
        return {
          capability_id: capability.capability_id,
          inputs,
          output: {
            staging_root: { kind: "local_path", path: stagingRoot },
            staging_policy: "require_empty",
          },
          options: selected.options,
        };
      },
    });
    return { completed, temporaryRoot };
  } catch (error) {
    const publication = newPublication();
    await cleanupPublicationPath(temporaryRoot, publication, "staging_cleanup_failed");
    throw publicationFailure(error, publication);
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

function parseCapability(value: JsonObject): MachineCapability {
  const capabilityId = requiredStringValue(value.capability_id, "capability.capability_id");
  const operation = requiredStringValue(value.operation, "capability.operation");
  const optimizationId =
    value.optimization_id === undefined
      ? undefined
      : requiredStringValue(value.optimization_id, "capability.optimization_id");
  if (optimizationId !== undefined && operation !== "transform") {
    throw new DocWenMachineError(
      "docwen_machine_protocol_error",
      "An optimization capability must be a transform operation.",
    );
  }
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
    operation,
    ...(optimizationId === undefined ? {} : { optimization_id: optimizationId }),
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
    const metadata = await lstat(canonicalPath, { bigint: true });
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new DocWenMachineError("docwen_input_not_regular_file", "Input changed before fingerprinting.");
    }
    const digest = await hashFile(canonicalPath);
    const after = await lstat(canonicalPath, { bigint: true });
    if (!samePathIdentity(after, pathIdentity(metadata))) {
      throw new DocWenMachineError(
        "docwen_source_changed",
        "Input changed while its fingerprint was being prepared.",
      );
    }
    handles.push({
      input_id: `input.${index + 1}`,
      locator: { kind: "local_path", path: canonicalPath },
      kind: input.kind,
      role: input.role,
      logical_path: logicalPath,
      media_type: mediaTypeForInput(canonicalPath, input.role),
      size_bytes: Number(metadata.size),
      sha256: digest,
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
  return mediaType !== MARKDOWN_MEDIA_TYPE && mediaType !== DOCX_MEDIA_TYPE;
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

function taskResult(
  completed: MachineTaskCompleted,
  outputRoot: string,
  artifactPaths: string[],
  preferredArtifactPath: string,
  inPlace: boolean,
  publication: Publication,
): JsonObject {
  return {
    ...publicationResult(publication),
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
    diagnostic_summary: diagnosticSummary({
      publication,
      outputCount: artifactPaths.length,
      diagnosticCount: completed.diagnostics.length,
    }),
  };
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

export const clientTesting = {
  buildConversionOptions,
  buildInputHandles,
  capabilityAcceptsInputs,
  parsePageSelection,
  parseCapability,
  selectConversionCapability,
  requiredInputArray,
  validateLogicalPath,
  validateTemplateResources,
};
