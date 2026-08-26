import { Type } from "typebox";
import { Check } from "typebox/value";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { executeDocWenToolMock } = vi.hoisted(() => ({
  executeDocWenToolMock: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] })),
}));

vi.mock("../docwen/client.js", () => ({ executeDocWenTool: executeDocWenToolMock }));

import { defineDocWenTools, toolDefinitionsTesting } from "./definitions.js";

describe("public typed input schema", () => {
  const schema = Type.Array(toolDefinitionsTesting.typedInputValue(), { minItems: 1 });

  it("expresses the exact-two Markdown-to-DOCX inputs", () => {
    expect(
      Check(schema, [
        {
          file: "C:\\inputs\\document.resolved.json",
          kind: "document",
          role: "neutral_document",
          logicalPath: "inputs/document.resolved.json",
        },
        {
          file: "C:\\inputs\\numbering-export-plan.json",
          kind: "resource",
          role: "numbering_export_plan",
          logicalPath: "inputs/numbering-export-plan.json",
        },
      ]),
    ).toBe(true);
  });

  it("rejects exact-two roles paired with the wrong kinds", () => {
    expect(
      Check(schema, [
        {
          file: "/inputs/document.resolved.json",
          kind: "resource",
          role: "neutral_document",
          logicalPath: "inputs/document.resolved.json",
        },
      ]),
    ).toBe(false);
    expect(
      Check(schema, [
        {
          file: "/inputs/numbering-export-plan.json",
          kind: "document",
          role: "numbering_export_plan",
          logicalPath: "inputs/numbering-export-plan.json",
        },
      ]),
    ).toBe(false);
  });
});

describe("tool definitions", () => {
  beforeEach(() => executeDocWenToolMock.mockClear());

  it("builds the exact current catalogue and forwards execution context", async () => {
    const toolFactory = vi.fn((definition: object) => definition);
    const definitions = defineDocWenTools(toolFactory as never) as unknown as Array<{
      name: string;
      optional?: boolean;
      execute: (params: object, config: object, context: { signal: AbortSignal }) => Promise<unknown>;
    }>;

    expect(definitions.map(({ name }) => name)).toEqual([
      "docwen_info",
      "docwen_inspect",
      "docwen_resources",
      "docwen_validate_markdown",
      "docwen_convert",
      "docwen_number_markdown",
      "docwen_merge_pdfs",
      "docwen_split_pdf",
      "docwen_merge_tables",
      "docwen_merge_images_to_tiff",
    ]);
    expect(definitions.slice(0, 4).every(({ optional }) => optional !== true)).toBe(true);
    expect(definitions.slice(4).every(({ optional }) => optional === true)).toBe(true);

    const signal = new AbortController().signal;
    const params = { file: "C:\\input.docx" };
    const config = { language: "zh_CN" };
    await definitions[1]!.execute(params, config, { signal });

    expect(executeDocWenToolMock).toHaveBeenCalledWith("docwen_inspect", params, config, signal);
  });
});
