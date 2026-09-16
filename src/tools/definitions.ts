import { Type } from "typebox";
import type { DefineToolPluginOptions, ToolPluginExecutionContext } from "openclaw/plugin-sdk/tool-plugin";

import type { docwenConfigSchema, DocWenPluginConfig } from "../config.js";
import { executeDocWenTool } from "../docwen/client.js";

type DefineTools = DefineToolPluginOptions<typeof docwenConfigSchema>["tools"];
type DefineTool = Parameters<DefineTools>[0];
type DefinedTool = ReturnType<DefineTool>;

const pathValue = () =>
  Type.String({ minLength: 1, description: "Absolute path on the OpenClaw Gateway host." });
const outputDirectoryValue = () =>
  Type.String({
    minLength: 1,
    description: "Explicit absolute directory for the committed Artifact Bundle.",
  });
const overwriteValue = () => Type.Optional(Type.Boolean({ default: false }));
const logicalPathValue = () =>
  Type.String({
    minLength: 1,
    description:
      "Case-sensitive relative POSIX path in this request's virtual root; never inferred from disk.",
  });
const templateIdValue = () =>
  Type.String({
    minLength: 1,
    description:
      "Canonical DocWen template resource ID returned by docwen_resources(kind=\"templates\"); never a file path or display name.",
  });
const typedInputValue = () =>
  Type.Union([
    Type.Object(
      {
        file: pathValue(),
        kind: Type.Literal("document"),
        role: Type.Union([Type.Literal("source"), Type.Literal("neutral_document")]),
        logicalPath: logicalPathValue(),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        file: pathValue(),
        kind: Type.Literal("resource"),
        role: Type.Union([
          Type.Literal("source"),
          Type.Literal("linked_resource"),
          Type.Literal("bibliography"),
          Type.Literal("citation_style"),
          Type.Literal("numbering_export_plan"),
        ]),
        logicalPath: logicalPathValue(),
      },
      { additionalProperties: false },
    ),
  ]);

function execute(toolName: string) {
  return (params: object, config: DocWenPluginConfig, context: ToolPluginExecutionContext) =>
    executeDocWenTool(toolName, params as Record<string, unknown>, config, context.signal);
}

export function defineDocWenTools(tool: DefineTool): DefinedTool[] {
  return [
    tool({
      name: "docwen_info",
      label: "DocWen information",
      description: "Read DocWen product, protocol, capability, platform, and diagnostic status.",
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: execute("docwen_info"),
    }),
    tool({
      name: "docwen_inspect",
      label: "Inspect a document",
      description: "Inspect one file's actual format and supported DocWen operations without modifying it.",
      parameters: Type.Object({ file: pathValue() }, { additionalProperties: false }),
      execute: execute("docwen_inspect"),
    }),
    tool({
      name: "docwen_resources",
      label: "Discover DocWen resources",
      description: "List or inspect stable DocWen formats, optimizations, templates, or numbering schemes.",
      parameters: Type.Object(
        {
          kind: Type.Union([
            Type.Literal("formats"),
            Type.Literal("optimizations"),
            Type.Literal("templates"),
            Type.Literal("numbering-schemes"),
          ]),
          id: Type.Optional(Type.String({ minLength: 1 })),
          target: Type.Optional(Type.Union([Type.Literal("docx"), Type.Literal("xlsx")])),
        },
        { additionalProperties: false },
      ),
      execute: execute("docwen_resources"),
    }),
    tool({
      name: "docwen_validate_markdown",
      label: "Validate Markdown",
      description:
        "Validate one Markdown document and return its structured report without modifying the source.",
      parameters: Type.Object(
        {
          file: pathValue(),
          enableSymbolPairing: Type.Optional(Type.Boolean()),
          enableSymbolCorrection: Type.Optional(Type.Boolean()),
          enableTyposRule: Type.Optional(Type.Boolean()),
          enableSensitiveWord: Type.Optional(Type.Boolean()),
          skipCodeBlocks: Type.Optional(Type.Boolean()),
          skipQuoteBlocks: Type.Optional(Type.Boolean()),
        },
        { additionalProperties: false },
      ),
      execute: execute("docwen_validate_markdown"),
    }),
    tool({
      name: "docwen_convert",
      label: "Convert a document",
      description:
        "Convert explicitly typed inputs and transactionally commit the complete Artifact Bundle to an explicit directory.",
      parameters: Type.Object(
        {
          inputs: Type.Array(typedInputValue(), { minItems: 1 }),
          to: Type.String({ minLength: 1 }),
          outputDir: outputDirectoryValue(),
          overwrite: overwriteValue(),
          template: Type.Optional(templateIdValue()),
          keepImages: Type.Optional(Type.Boolean()),
          ocr: Type.Optional(Type.Boolean()),
          ocrLanguage: Type.Optional(Type.String({ minLength: 1 })),
          removeNumbering: Type.Optional(Type.Boolean()),
          addNumbering: Type.Optional(Type.Boolean()),
          numberingScheme: Type.Optional(Type.String({ minLength: 1 })),
        },
        { additionalProperties: false },
      ),
      optional: true,
      execute: execute("docwen_convert"),
    }),
    tool({
      name: "docwen_number_markdown",
      label: "Number Markdown headings",
      description:
        "Add or remove Markdown heading numbering using an explicit Bundle directory or in-place authorization.",
      parameters: Type.Object(
        {
          file: pathValue(),
          operation: Type.Union([Type.Literal("add"), Type.Literal("remove")]),
          scheme: Type.Optional(Type.String({ minLength: 1 })),
          outputDir: Type.Optional(outputDirectoryValue()),
          inPlace: Type.Optional(Type.Boolean({ default: false })),
          overwrite: overwriteValue(),
        },
        { additionalProperties: false },
      ),
      optional: true,
      execute: execute("docwen_number_markdown"),
    }),
    tool({
      name: "docwen_merge_pdfs",
      label: "Merge PDF files",
      description: "Merge PDF inputs in caller-provided order and commit the resulting Bundle directory.",
      parameters: Type.Object(
        {
          inputs: Type.Array(typedInputValue(), { minItems: 2 }),
          outputDir: outputDirectoryValue(),
          overwrite: overwriteValue(),
        },
        { additionalProperties: false },
      ),
      optional: true,
      execute: execute("docwen_merge_pdfs"),
    }),
    tool({
      name: "docwen_split_pdf",
      label: "Split a PDF",
      description: "Split selected one-based PDF pages into a transactional Artifact Bundle directory.",
      parameters: Type.Object(
        {
          file: pathValue(),
          pages: Type.String({ minLength: 1, pattern: "^[0-9,\\-]+$" }),
          outputDir: pathValue(),
          overwrite: overwriteValue(),
        },
        { additionalProperties: false },
      ),
      optional: true,
      execute: execute("docwen_split_pdf"),
    }),
    tool({
      name: "docwen_merge_tables",
      label: "Merge tables",
      description: "Merge XLSX table inputs and commit the resulting Artifact Bundle directory.",
      parameters: Type.Object(
        {
          inputs: Type.Array(typedInputValue(), { minItems: 2 }),
          mode: Type.Union([Type.Literal("row"), Type.Literal("col"), Type.Literal("cell")]),
          offsetRange: Type.Optional(Type.Integer({ minimum: 0, maximum: 50 })),
          outputDir: outputDirectoryValue(),
          overwrite: overwriteValue(),
        },
        { additionalProperties: false },
      ),
      optional: true,
      execute: execute("docwen_merge_tables"),
    }),
    tool({
      name: "docwen_merge_images_to_tiff",
      label: "Merge images to TIFF",
      description: "Merge image inputs into TIFF and commit the resulting Artifact Bundle directory.",
      parameters: Type.Object(
        {
          inputs: Type.Array(typedInputValue(), { minItems: 2 }),
          outputDir: outputDirectoryValue(),
          overwrite: overwriteValue(),
          keepAlpha: Type.Optional(Type.Boolean()),
          mode: Type.Optional(Type.Union([Type.Literal("smart"), Type.Literal("rgb"), Type.Literal("RGB")])),
        },
        { additionalProperties: false },
      ),
      optional: true,
      execute: execute("docwen_merge_images_to_tiff"),
    }),
  ];
}

export const toolDefinitionsTesting = { typedInputValue };
