import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as MachineClientModule from "./machine-client.js";
import type * as OutputTransactionModule from "./output-transaction.js";

const mocks = vi.hoisted(() => ({ query: vi.fn(), planned: vi.fn() }));
vi.mock("./path.js", () => ({ resolveDocWenBinary: async () => process.execPath }));
vi.mock("./machine-client.js", async (original) => {
  const actual = await original<typeof MachineClientModule>();
  return {
    ...actual,
    runDocWenMachineQuery: mocks.query,
    runDocWenMachineTask: async (options: Parameters<typeof actual.runDocWenMachineTask>[0]) => {
      const request =
        typeof options.request === "function"
          ? await options.request(async (method, params) => (await mocks.query({ method, params })).result)
          : options.request;
      mocks.planned(request);
      throw new actual.DocWenMachineError("probe_stop", "Input reached task planning.");
    },
  };
});
vi.mock("./output-transaction.js", async (original) => ({
  ...(await original<typeof OutputTransactionModule>()),
  // These tests stop at planning; publication has its own filesystem tests.
  preflightOutputDirectory: vi.fn(async () => null),
}));

import { executeDocWenTool } from "./client.js";
import { EXACT_TWO_MARKDOWN_TO_DOCX_CAPABILITY } from "./test-fixtures.js";

const roots: string[] = [];
const sourceBytes = Buffer.from("format-routing fixture\n");
const formats = [
  ["doc", "document", "application/msword"],
  ["wps", "document", "application/vnd.ms-works"],
  ["rtf", "document", "application/rtf"],
  ["odt", "document", "application/vnd.oasis.opendocument.text"],
  ["ofd", "resource", "application/vnd.ofd"],
  ["xps", "resource", "application/vnd.ms-xpsdocument"],
] as const;

function conversionCapability(extension: string, kind: string, mediaType: string) {
  return {
    capability_id: `convert.${extension}.to_markdown`,
    operation: "convert",
    input_shape: {
      slots: [{ role: "source", kind, media_types: [mediaType], min_items: 1, max_items: 1 }],
      undeclared_roles: "reject",
    },
    output_media_types: ["text/markdown"],
    output_shape: {
      cardinality: "many",
      artifact_kinds: ["document", "fragment", "resource"],
      relation_types: ["fragment_of", "resource_of"],
      atomic_bundle: true,
    },
    options_schema: { type: "object", properties: {}, additionalProperties: false },
    availability: "available",
    dependencies: [],
    limitations: [],
  };
}

async function sourceFile(extension: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "docwen-input-format-"));
  roots.push(root);
  const file = path.join(root, `source.${extension.toUpperCase()}`);
  await writeFile(file, sourceBytes);
  return file;
}

beforeEach(() => {
  mocks.query.mockReset();
  mocks.planned.mockReset();
});
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("formats advertised by DocWen Machine capabilities", () => {
  it.each([true, false])(
    "uses ordinary Markdown and an explicit image only when the source capability is available (%s)",
    async (available) => {
      const file = await sourceFile("md");
      const image = path.join(path.dirname(file), "chart.png");
      await writeFile(image, Buffer.from([137, 80, 78, 71]));
      const sourceCapability = {
        ...conversionCapability("markdown_source", "document", "text/markdown"),
        capability_id: "convert.markdown_source.to_docx",
        input_shape: {
          slots: [
            { role: "source", kind: "document", media_types: ["text/markdown"], min_items: 1, max_items: 1 },
            { role: "linked_resource", kind: "resource", media_types: ["image/png"], min_items: 0 },
          ],
          undeclared_roles: "reject",
        },
        output_media_types: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
        availability: available ? "available" : "unavailable",
      };
      mocks.query.mockResolvedValue({
        result: { capabilities: [EXACT_TWO_MARKDOWN_TO_DOCX_CAPABILITY, sourceCapability] },
      });
      const result = await executeDocWenTool(
        "docwen_convert",
        {
          inputs: [
            { file, kind: "document", role: "source", logicalPath: "documents/report.md" },
            {
              file: image,
              kind: "resource",
              role: "linked_resource",
              logicalPath: "documents/assets/chart.png",
            },
          ],
          to: "docx",
          outputDir: path.join(path.dirname(file), "result"),
        },
        {},
      );

      if (available) {
        expect(mocks.planned).toHaveBeenCalledWith(
          expect.objectContaining({
            capability_id: "convert.markdown_source.to_docx",
            inputs: [
              expect.objectContaining({ role: "source", media_type: "text/markdown" }),
              expect.objectContaining({ role: "linked_resource", media_type: "image/png" }),
            ],
          }),
        );
      } else {
        expect(mocks.planned).not.toHaveBeenCalled();
        expect(result).toMatchObject({ status: "failed", error: { code: "docwen_capability_unavailable" } });
      }
    },
  );

  it.each(formats)(
    "forwards a %s conversion with its canonical kind and media type",
    async (extension, kind, mediaType) => {
      const file = await sourceFile(extension);
      const capability = conversionCapability(extension, kind, mediaType);
      mocks.query.mockResolvedValue({ result: { capabilities: [capability] } });

      const result = await executeDocWenTool(
        "docwen_convert",
        {
          inputs: [{ file, kind, role: "source", logicalPath: `documents/source.${extension}` }],
          to: "md",
          outputDir: path.join(path.dirname(file), "result"),
        },
        {},
      );

      expect(mocks.planned).toHaveBeenCalledWith(
        expect.objectContaining({
          capability_id: capability.capability_id,
          inputs: [
            expect.objectContaining({
              kind,
              role: "source",
              logical_path: `documents/source.${extension}`,
              media_type: mediaType,
              size_bytes: sourceBytes.length,
              sha256: createHash("sha256").update(sourceBytes).digest("hex"),
            }),
          ],
        }),
      );
      expect(result).toMatchObject({ status: "failed", error: { code: "probe_stop" } });
    },
  );

  it.each(formats)(
    "can inspect a %s file before choosing a conversion",
    async (extension, kind, mediaType) => {
      const file = await sourceFile(extension);
      const inspection = { detected_format: extension, decision: "accept" };
      mocks.query.mockResolvedValue({ result: inspection });

      expect(await executeDocWenTool("docwen_inspect", { file }, {})).toEqual(inspection);
      expect(mocks.query).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "file/inspect",
          params: { input: expect.objectContaining({ kind, role: "source", media_type: mediaType }) },
        }),
      );
      expect(mocks.planned).not.toHaveBeenCalled();
    },
  );

  it.each(["available", "unavailable"])(
    "keeps a legacy Word optimizer gated by its advertised availability (%s)",
    async (availability) => {
      const file = await sourceFile("doc");
      const ordinary = conversionCapability("doc", "document", "application/msword");
      const optimized = {
        ...ordinary,
        capability_id: "optimize.gongwen.doc.to_markdown",
        operation: "transform",
        optimization_id: "gongwen",
        availability,
      };
      mocks.query.mockResolvedValue({ result: { capabilities: [ordinary, optimized] } });

      const result = await executeDocWenTool(
        "docwen_convert",
        {
          inputs: [{ file, kind: "document", role: "source", logicalPath: "source.doc" }],
          to: "md",
          optimization: "gongwen",
          outputDir: path.join(path.dirname(file), "result"),
        },
        {},
      );

      if (availability === "available") {
        expect(mocks.planned).toHaveBeenCalledWith(
          expect.objectContaining({ capability_id: optimized.capability_id }),
        );
      } else {
        expect(mocks.planned).not.toHaveBeenCalled();
        expect(result).toMatchObject({ status: "failed", error: { code: "docwen_capability_unavailable" } });
      }
    },
  );
});
