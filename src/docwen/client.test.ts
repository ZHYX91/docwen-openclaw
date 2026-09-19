import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { clientTesting } from "./client.js";
import { EXACT_TWO_MARKDOWN_TO_DOCX_CAPABILITY } from "./fixtures.generated.js";
import type { MachineInputHandle, ValidatedArtifactBundle } from "./machine-client.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function root(): Promise<string> {
  const value = await mkdtemp(path.join(tmpdir(), "docwen-openclaw-client-test-"));
  roots.push(value);
  return value;
}

async function oneArtifactBundle(
  workspace: string,
  name: string,
  content: string,
): Promise<ValidatedArtifactBundle> {
  const staging = path.join(workspace, `staging-${name}`);
  const artifactPath = path.join(staging, "result.md");
  const bytes = Buffer.from(content, "utf8");
  await mkdir(staging);
  await writeFile(artifactPath, bytes);
  return {
    schema: "docwen.artifact_bundle.v3",
    bundle_id: `bundle.${name}`,
    task_id: `task.${name}`,
    producer: { name: "DocWen", product_version: "0.9.0", machine_protocol: "docwen.machine.v2" },
    layout_schema: "docwen.artifact_layout.v1",
    artifacts: [
      {
        artifact_id: `artifact.${name}`,
        kind: "document",
        locator: "result.md",
        logical_path: "result.md",
        suggested_name: "result.md",
        media_type: "text/markdown",
        size_bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        absolutePath: artifactPath,
      },
    ],
    entries: [{ artifact_id: `artifact.${name}`, role: "primary", ordinal: 0, preferred: true }],
    relations: [],
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function expectedContent(content: string): { sizeBytes: number; sha256: string } {
  const bytes = Buffer.from(content, "utf8");
  return {
    sizeBytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

describe("OpenClaw Artifact Bundle commit", () => {
  it("commits all verified artifacts and its portable manifest as one directory", async () => {
    const workspace = await root();
    const staging = path.join(workspace, "staging");
    const output = path.join(workspace, "bundle-output");
    await mkdir(path.join(staging, "documents"), { recursive: true });
    await mkdir(path.join(staging, "resources"), { recursive: true });
    const markdown = Buffer.from("# Result\n", "utf8");
    const image = Buffer.from([1, 2, 3]);
    const markdownPath = path.join(staging, "documents", "result.md");
    const imagePath = path.join(staging, "resources", "image.png");
    await writeFile(markdownPath, markdown);
    await writeFile(imagePath, image);
    const bundle: ValidatedArtifactBundle = {
      schema: "docwen.artifact_bundle.v3",
      bundle_id: "bundle.test",
      task_id: "task.test",
      producer: { name: "DocWen", product_version: "0.9.0", machine_protocol: "docwen.machine.v2" },
      layout_schema: "docwen.artifact_layout.v1",
      artifacts: [
        {
          artifact_id: "document.1",
          kind: "document",
          locator: "documents/result.md",
          logical_path: "report/result.md",
          suggested_name: "result.md",
          media_type: "text/markdown",
          size_bytes: markdown.length,
          sha256: createHash("sha256").update(markdown).digest("hex"),
          absolutePath: markdownPath,
        },
        {
          artifact_id: "resource.1",
          kind: "resource",
          locator: "resources/image.png",
          logical_path: "report/assets/image.png",
          suggested_name: "image.png",
          media_type: "image/png",
          size_bytes: image.length,
          sha256: createHash("sha256").update(image).digest("hex"),
          absolutePath: imagePath,
        },
      ],
      entries: [{ artifact_id: "document.1", role: "primary", ordinal: 0, preferred: true }],
      relations: [
        {
          type: "resource_of",
          source_artifact_id: "resource.1",
          target_artifact_id: "document.1",
          role: "image",
        },
      ],
    };

    const committed = await clientTesting.atomicCommitBundle(bundle, output, false);
    expect(await readFile(committed.preferredArtifactPath, "utf8")).toBe("# Result\n");
    expect(await readFile(path.join(output, "report", "assets", "image.png"))).toEqual(image);
    const manifest = JSON.parse(await readFile(path.join(output, ".docwen-artifact-bundle.json"), "utf8"));
    expect(manifest.artifacts[0]).not.toHaveProperty("absolutePath");
    expect(manifest.artifacts[0].logical_path).toBe("report/result.md");
    expect(manifest.layout_schema).toBe("docwen.artifact_layout.v1");
    expect(manifest.relations).toEqual(bundle.relations);
  });

  it("refuses implicit overwrite and atomically replaces a regular in-place target", async () => {
    const workspace = await root();
    const output = path.join(workspace, "existing");
    const source = path.join(workspace, "source.md");
    const replacement = path.join(workspace, "replacement.md");
    await mkdir(output);
    await writeFile(source, "old", "utf8");
    await writeFile(replacement, "new", "utf8");

    const emptyBundle = {
      schema: "docwen.artifact_bundle.v3",
      bundle_id: "bundle.empty",
      task_id: "task.empty",
      producer: { name: "DocWen", product_version: "0.9.0", machine_protocol: "docwen.machine.v2" },
      layout_schema: "docwen.artifact_layout.v1",
      artifacts: [],
      entries: [],
      relations: [],
    } as ValidatedArtifactBundle;
    await expect(clientTesting.atomicCommitBundle(emptyBundle, output, false)).rejects.toMatchObject({
      code: "docwen_output_exists",
    });
    await clientTesting.atomicReplaceFile(source, replacement, expectedContent("new"));
    expect(await readFile(source, "utf8")).toBe("new");
  });

  it("keeps a committed Bundle when old-backup cleanup fails", async () => {
    const workspace = await root();
    const output = path.join(workspace, "replace-output");
    await mkdir(output);
    await writeFile(path.join(output, "old.txt"), "old", "utf8");
    const bundle = await oneArtifactBundle(workspace, "replacement", "new");
    const warnings: string[] = [];

    const committed = await clientTesting.atomicCommitBundle(bundle, output, true, {
      cleanupBackup: async () => {
        throw new Error("simulated cleanup failure");
      },
      onCleanupWarning: (warning) => warnings.push(warning),
    });

    expect(await readFile(committed.preferredArtifactPath, "utf8")).toBe("new");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("was committed");
    expect((await readdir(workspace)).some((name) => name.includes(".docwen-backup-"))).toBe(true);
  });

  it("fails a concurrent Bundle commit without clobbering the lock holder", async () => {
    const workspace = await root();
    const output = path.join(workspace, "shared-output");
    const firstBundle = await oneArtifactBundle(workspace, "first", "first writer");
    const secondBundle = await oneArtifactBundle(workspace, "second", "second writer");
    const entered = deferred();
    const release = deferred();
    const first = clientTesting.atomicCommitBundle(firstBundle, output, false, {
      beforeSwap: async () => {
        entered.resolve();
        await release.promise;
      },
    });
    await entered.promise;
    try {
      await expect(clientTesting.atomicCommitBundle(secondBundle, output, false)).rejects.toMatchObject({
        code: "docwen_output_busy",
      });
    } finally {
      release.resolve();
    }
    await first;

    expect(await readFile(path.join(output, "result.md"), "utf8")).toBe("first writer");
    expect((await readdir(workspace)).filter((name) => name.includes(".docwen-"))).toEqual([]);
  });

  it("detects a replaced output directory immediately before the atomic swap", async () => {
    const workspace = await root();
    const output = path.join(workspace, "replaceable-output");
    const movedOutput = path.join(workspace, "original-output");
    const nextBundle = await oneArtifactBundle(workspace, "next", "next writer");
    await mkdir(output);
    await writeFile(path.join(output, "original.txt"), "original", "utf8");

    await expect(
      clientTesting.atomicCommitBundle(nextBundle, output, true, {
        beforeSwap: async () => {
          await rename(output, movedOutput);
          await mkdir(output);
          await writeFile(path.join(output, "intruder.txt"), "intruder", "utf8");
        },
      }),
    ).rejects.toMatchObject({ code: "docwen_output_changed" });

    expect(await readFile(path.join(output, "intruder.txt"), "utf8")).toBe("intruder");
    expect(await readFile(path.join(movedOutput, "original.txt"), "utf8")).toBe("original");
  });

  it("does not clobber an output directory that appears during a new commit", async () => {
    const workspace = await root();
    const output = path.join(workspace, "appearing-output");
    const nextBundle = await oneArtifactBundle(workspace, "appearing", "next writer");

    await expect(
      clientTesting.atomicCommitBundle(nextBundle, output, false, {
        beforeSwap: async () => {
          await mkdir(output);
          await writeFile(path.join(output, "intruder.txt"), "intruder", "utf8");
        },
      }),
    ).rejects.toMatchObject({ code: "docwen_output_exists" });

    expect(await readFile(path.join(output, "intruder.txt"), "utf8")).toBe("intruder");
  });

  it("revalidates copied Bundle bytes before publishing the transaction", async () => {
    const workspace = await root();
    const output = path.join(workspace, "tampered-output");
    const tampered = await oneArtifactBundle(workspace, "tampered", "validated bytes");
    await writeFile(tampered.artifacts[0]!.absolutePath, "changed after validation", "utf8");

    await expect(clientTesting.atomicCommitBundle(tampered, output, false)).rejects.toMatchObject({
      code: "docwen_machine_integrity_error",
    });
    expect(await readdir(workspace)).not.toContain("tampered-output");
  });

  it("fails a concurrent in-place replacement and preserves the lock holder", async () => {
    const workspace = await root();
    const destination = path.join(workspace, "document.md");
    const firstReplacement = path.join(workspace, "first.md");
    const secondReplacement = path.join(workspace, "second.md");
    await writeFile(destination, "original", "utf8");
    await writeFile(firstReplacement, "first", "utf8");
    await writeFile(secondReplacement, "second", "utf8");
    const entered = deferred();
    const release = deferred();
    const first = clientTesting.atomicReplaceFile(destination, firstReplacement, expectedContent("first"), {
      beforeSwap: async () => {
        entered.resolve();
        await release.promise;
      },
    });
    await entered.promise;
    try {
      await expect(
        clientTesting.atomicReplaceFile(destination, secondReplacement, expectedContent("second")),
      ).rejects.toMatchObject({ code: "docwen_output_busy" });
    } finally {
      release.resolve();
    }
    await first;

    expect(await readFile(destination, "utf8")).toBe("first");
    expect((await readdir(workspace)).filter((name) => name.includes(".docwen-"))).toEqual([]);
  });

  it("refuses an in-place replacement when the source changed after task preparation", async () => {
    const workspace = await root();
    const destination = path.join(workspace, "document.md");
    const replacement = path.join(workspace, "replacement.md");
    await writeFile(destination, "original", "utf8");
    await writeFile(replacement, "replacement", "utf8");
    const sourceVersion = expectedContent("original");

    await writeFile(destination, "newer user content", "utf8");

    await expect(
      clientTesting.atomicReplaceFile(
        destination,
        replacement,
        expectedContent("replacement"),
        {},
        sourceVersion,
      ),
    ).rejects.toMatchObject({ code: "docwen_source_changed" });
    expect(await readFile(destination, "utf8")).toBe("newer user content");
  });

  it("keeps an in-place replacement when old-backup cleanup fails", async () => {
    const workspace = await root();
    const destination = path.join(workspace, "document.md");
    const replacement = path.join(workspace, "replacement.md");
    await writeFile(destination, "old", "utf8");
    await writeFile(replacement, "new", "utf8");
    const warnings: string[] = [];

    await clientTesting.atomicReplaceFile(destination, replacement, expectedContent("new"), {
      cleanupBackup: async () => {
        throw new Error("simulated cleanup failure");
      },
      onCleanupWarning: (warning) => warnings.push(warning),
    });

    expect(await readFile(destination, "utf8")).toBe("new");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("was committed");
  });

  it("detects an in-place target mutation immediately before replacement", async () => {
    const workspace = await root();
    const destination = path.join(workspace, "document.md");
    const replacement = path.join(workspace, "replacement.md");
    await writeFile(destination, "original", "utf8");
    await writeFile(replacement, "replacement", "utf8");

    await expect(
      clientTesting.atomicReplaceFile(destination, replacement, expectedContent("replacement"), {
        beforeSwap: async () => writeFile(destination, "concurrent mutation", "utf8"),
      }),
    ).rejects.toMatchObject({ code: "docwen_output_changed" });
    expect(await readFile(destination, "utf8")).toBe("concurrent mutation");
  });

  it("expands ordered page ranges and rejects overlaps", () => {
    expect(clientTesting.parsePageSelection("1-3,5,7-8")).toEqual([1, 2, 3, 5, 7, 8]);
    expect(() => clientTesting.parsePageSelection("1-3,3")).toThrow("PDF page is selected twice");
    expect(() => clientTesting.parsePageSelection("4-2")).toThrow("Invalid PDF page range");
  });
});

describe("capability-driven conversion options", () => {
  const capability = (properties: Record<string, unknown>) =>
    clientTesting.parseCapability({
      capability_id: "convert.test.to_markdown",
      operation: "convert",
      input_shape: {
        slots: [
          { role: "source", kind: "document", media_types: ["application/pdf"], min_items: 1, max_items: 1 },
        ],
        undeclared_roles: "reject",
      },
      output_media_types: ["text/markdown"],
      output_shape: {
        cardinality: "one",
        artifact_kinds: ["document"],
        relation_types: [],
        atomic_bundle: true,
      },
      options_schema: { type: "object", properties, additionalProperties: false },
      availability: "available",
      dependencies: [],
      limitations: [],
    });

  const input: MachineInputHandle = {
    input_id: "input.1",
    locator: { kind: "local_path", path: "/source.pdf" },
    kind: "document",
    role: "source",
    logical_path: "source.pdf",
    media_type: "application/pdf",
    size_bytes: 1,
    sha256: "a".repeat(64),
  };

  it("selects an optimization by its resource identity without guessing capability names", () => {
    const ordinary = capability({});
    const optimized = clientTesting.parseCapability({
      ...ordinary,
      capability_id: "opaque-optimizer-capability",
      operation: "transform",
      optimization_id: "public-optimizer",
    });
    expect(clientTesting.selectConversionCapability([optimized, ordinary], [input], "text/markdown")).toBe(
      ordinary,
    );
    expect(
      clientTesting.selectConversionCapability(
        [ordinary, optimized],
        [input],
        "text/markdown",
        "public-optimizer",
      ),
    ).toBe(optimized);
  });

  it.each([
    { availability: "unavailable" as const },
    { output_media_types: ["application/pdf"] },
    { optimization_id: "another-optimizer" },
    { operation: "convert" },
    {
      input_shape: {
        slots: [
          {
            role: "source" as const,
            kind: "document" as const,
            media_types: ["text/markdown"],
            min_items: 1,
            max_items: 1,
          },
        ],
        undeclared_roles: "reject" as const,
      },
    },
  ])("rejects an inapplicable optimizer without falling back to ordinary conversion: %j", (change) => {
    const ordinary = capability({});
    const optimized = { ...ordinary, operation: "transform", optimization_id: "public-optimizer", ...change };
    expect(() =>
      clientTesting.selectConversionCapability(
        [ordinary, optimized],
        [input],
        "text/markdown",
        "public-optimizer",
      ),
    ).toThrow(expect.objectContaining({ code: "docwen_capability_unavailable" }));
  });

  it("rejects ambiguous optimizers", () => {
    const optimized = { ...capability({}), operation: "transform", optimization_id: "public-optimizer" };
    expect(() =>
      clientTesting.selectConversionCapability(
        [optimized, { ...optimized, capability_id: "another" }],
        [input],
        "text/markdown",
        "public-optimizer",
      ),
    ).toThrow(expect.objectContaining({ code: "docwen_capability_ambiguous" }));
  });

  it.each([
    { optimization_id: "public-optimizer", operation: "convert" },
    { optimization_id: "", operation: "transform" },
    { optimization_id: null, operation: "transform" },
  ])("rejects malformed optimization capability metadata: %j", (change) => {
    expect(() => clientTesting.parseCapability({ ...capability({}), ...change })).toThrow();
  });

  it("maps semantic OCR and resource preferences to the selected capability contract", () => {
    const modern = capability({
      recognize_text: { type: "boolean" },
      preserve_resources: { type: "boolean" },
      image_mode: { type: "string", enum: ["file"] },
      ocr_language: { type: "string" },
    });
    expect(
      clientTesting.buildConversionOptions(modern, {
        ocr: true,
        keepImages: false,
        ocrLanguage: "chi_sim",
      }),
    ).toEqual({
      recognize_text: true,
      preserve_resources: false,
      ocr_language: "chi_sim",
    });

    const legacy = capability({
      to_md_enable_ocr: { type: "boolean" },
      to_md_keep_images: { type: "boolean" },
      image_mode: { type: "string", enum: ["file", "omit"] },
    });
    expect(clientTesting.buildConversionOptions(legacy, { ocr: false, keepImages: true })).toEqual({
      to_md_enable_ocr: false,
      to_md_keep_images: true,
      image_mode: "file",
    });
  });

  it("rejects an explicitly requested option that the capability does not expose", () => {
    expect(() => clientTesting.buildConversionOptions(capability({}), { ocr: true })).toThrow(
      "does not support the requested ocr option",
    );
  });

  it.each([
    ["ocrLanguage", "chi_sim", "ocr_language", { type: "string", enum: ["auto", "chinese", "english"] }],
    ["numberingScheme", "invented", "numbering_scheme", { type: "string", enum: ["gongwen_standard"] }],
    ["ocr", false, "recognize_text", { type: "boolean", enum: [true] }],
    ["keepImages", false, "preserve_resources", { type: "boolean", const: true }],
    ["removeNumbering", true, "remove_numbering", { type: "string" }],
    ["addNumbering", true, "add_numbering", { type: ["string", "null"] }],
    ["ocrLanguage", "english", "ocr_language", { type: "string", enum: "english" }],
  ])("rejects %s when its value violates the selected capability", (parameter, value, name, schema) => {
    expect(() =>
      clientTesting.buildConversionOptions(capability({ [String(name)]: schema }), {
        [String(parameter)]: value,
      }),
    ).toThrow(`does not support the requested ${String(parameter)} option`);
  });

  it("preserves supported values without renaming or dropping them", () => {
    const selected = capability({
      ocr_language: { type: "string", enum: ["chinese", "english"] },
      numbering_scheme: { type: "string", enum: ["gongwen_standard"] },
      remove_numbering: { type: ["boolean", "null"], const: false },
    });
    expect(
      clientTesting.buildConversionOptions(selected, {
        ocrLanguage: "english",
        numberingScheme: "gongwen_standard",
        removeNumbering: false,
      }),
    ).toEqual({ ocr_language: "english", numbering_scheme: "gongwen_standard", remove_numbering: false });
  });
});

describe("typed Machine input construction", () => {
  it("preserves explicit virtual paths and accepts a linked resource slot", async () => {
    const workspace = await root();
    const source = path.join(workspace, "physical-source", "report.md");
    const resource = path.join(workspace, "physical-resource", "provided.png");
    await mkdir(path.dirname(source), { recursive: true });
    await mkdir(path.dirname(resource), { recursive: true });
    await writeFile(source, "![chart](assets/chart.png)\n", "utf8");
    await writeFile(resource, Buffer.from([137, 80, 78, 71]));

    const inputs = await clientTesting.buildInputHandles([
      { file: source, kind: "document", role: "source", logicalPath: "doc/report.md" },
      {
        file: resource,
        kind: "resource",
        role: "linked_resource",
        logicalPath: "doc/assets/chart.png",
      },
    ]);
    expect(inputs).toMatchObject([
      { input_id: "input.1", kind: "document", role: "source", logical_path: "doc/report.md" },
      {
        input_id: "input.2",
        kind: "resource",
        role: "linked_resource",
        logical_path: "doc/assets/chart.png",
      },
    ]);

    const capability = clientTesting.parseCapability({
      capability_id: "convert.markdown.with_linked_resources",
      operation: "convert",
      input_shape: {
        slots: [
          { role: "source", kind: "document", media_types: ["text/markdown"], min_items: 1, max_items: 1 },
          { role: "linked_resource", kind: "resource", media_types: ["image/png"], min_items: 0 },
        ],
        undeclared_roles: "reject",
      },
      output_media_types: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
      output_shape: {
        cardinality: "one",
        artifact_kinds: ["document"],
        relation_types: [],
        atomic_bundle: true,
      },
      options_schema: {},
      availability: "available",
      dependencies: [],
      limitations: [],
    });
    expect(clientTesting.capabilityAcceptsInputs(capability, inputs)).toBe(true);
    expect(
      clientTesting.capabilityAcceptsInputs(capability, [
        { ...inputs[0]!, role: "bibliography", kind: "resource" },
      ]),
    ).toBe(false);

    const standaloneResource = await clientTesting.buildInputHandles([
      {
        file: resource,
        kind: "resource",
        role: "source",
        logicalPath: "standalone/provided.png",
      },
    ]);
    expect(standaloneResource[0]).toMatchObject({
      kind: "resource",
      role: "source",
      media_type: "image/png",
    });
  });

  it("accepts the authority exact-two Markdown-to-DOCX capability with every required field", async () => {
    const workspace = await root();
    const neutral = path.join(workspace, "document.resolved.json");
    const numberingPlan = path.join(workspace, "numbering-export-plan.json");
    await writeFile(neutral, "{}\n", "utf8");
    await writeFile(numberingPlan, "{}\n", "utf8");
    const specs = clientTesting.requiredInputArray(
      {
        inputs: [
          {
            file: neutral,
            kind: "document",
            role: "neutral_document",
            logicalPath: "inputs/document.resolved.json",
          },
          {
            file: numberingPlan,
            kind: "resource",
            role: "numbering_export_plan",
            logicalPath: "inputs/numbering-export-plan.json",
          },
        ],
      },
      "inputs",
    );

    const inputs = await clientTesting.buildInputHandles(specs);
    expect(inputs).toMatchObject([
      {
        kind: "document",
        role: "neutral_document",
        media_type: "application/vnd.docwen.resolved-document+json",
      },
      {
        kind: "resource",
        role: "numbering_export_plan",
        media_type: "application/vnd.docwen.numbering-export-plan+json",
      },
    ]);
    const capability = clientTesting.parseCapability(EXACT_TWO_MARKDOWN_TO_DOCX_CAPABILITY);
    expect(capability.dependencies).toEqual([]);
    expect(capability.limitations).toHaveLength(1);
    expect(clientTesting.capabilityAcceptsInputs(capability, inputs)).toBe(true);
    expect(
      clientTesting.capabilityAcceptsInputs(capability, [{ ...inputs[0]!, role: "source" }, inputs[1]!]),
    ).toBe(false);
  });

  it("rejects unsafe or ambiguous typed inputs before planning", async () => {
    const workspace = await root();
    const source = path.join(workspace, "source.md");
    const resource = path.join(workspace, "resource.png");
    await writeFile(source, "# source\n", "utf8");
    await writeFile(resource, Buffer.from([137, 80, 78, 71]));

    for (const logicalPath of [
      "",
      "/doc/source.md",
      "doc\\source.md",
      "doc/../source.md",
      "C:/source.md",
      "https://x/y",
    ]) {
      expect(() => clientTesting.validateLogicalPath(logicalPath)).toThrow("logicalPath");
    }
    await expect(
      clientTesting.buildInputHandles([
        { file: source, kind: "document", role: "source", logicalPath: "doc/source.md" },
        { file: resource, kind: "resource", role: "linked_resource", logicalPath: "doc/source.md" },
      ]),
    ).rejects.toMatchObject({ code: "docwen_duplicate_logical_path" });
    await expect(
      clientTesting.buildInputHandles([
        { file: source, kind: "document", role: "linked_resource", logicalPath: "doc/source.md" },
      ]),
    ).rejects.toMatchObject({ code: "docwen_invalid_input_role" });
  });

  it("rejects malformed capability input shapes", () => {
    const capability = {
      capability_id: "convert.markdown.to_docx",
      operation: "convert",
      input_shape: {
        slots: [{ role: "source", kind: "document", media_types: ["text/markdown"], min_items: 1 }],
        undeclared_roles: "allow",
      },
      output_media_types: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
      output_shape: {
        cardinality: "one",
        artifact_kinds: ["document"],
        relation_types: [],
        atomic_bundle: true,
      },
      options_schema: {},
      availability: "available",
      dependencies: [],
      limitations: [],
    };
    expect(() => clientTesting.parseCapability(capability)).toThrow("reject undeclared input roles");
    capability.input_shape.undeclared_roles = "reject";
    capability.input_shape.slots = [
      { role: "source", kind: "document", media_types: ["text/markdown"], min_items: 1 },
      { role: "source", kind: "document", media_types: ["text/markdown"], min_items: 1 },
    ];
    expect(() => clientTesting.parseCapability(capability)).toThrow("roles must be unique");
    expect(() =>
      clientTesting.parseCapability({
        ...capability,
        input_shape: {
          slots: [
            {
              role: "source",
              kind: "document",
              media_types: ["text/markdown"],
              min_items: 1,
              slot_id: "not-permitted",
            },
          ],
          undeclared_roles: "reject",
        },
      }),
    ).toThrow("unsupported property");
    expect(() =>
      clientTesting.parseCapability({
        ...capability,
        input_shape: {
          slots: [{ role: "source", kind: "document", media_types: ["text/markdown"], min_items: 1 }],
          undeclared_roles: "reject",
        },
      }),
    ).toThrow("exactly neutral_document and numbering_export_plan");
    const exactTwo = EXACT_TWO_MARKDOWN_TO_DOCX_CAPABILITY;
    const withoutDependencies: Record<string, unknown> = { ...exactTwo };
    delete withoutDependencies.dependencies;
    expect(() => clientTesting.parseCapability(withoutDependencies)).toThrow(
      "capability.dependencies must be an object array",
    );
    const withoutLimitations: Record<string, unknown> = { ...exactTwo };
    delete withoutLimitations.limitations;
    expect(() => clientTesting.parseCapability(withoutLimitations)).toThrow(
      "capability.limitations must be an object array",
    );
  });
});

describe("template discovery contract", () => {
  const template = {
    id: `template.docx.${"a".repeat(64)}`,
    target: "docx",
    name: "Standard",
    description: "",
    origin: "builtin",
    is_default: false,
  };

  it("preserves server order and allows duplicate display names with distinct IDs", () => {
    const items = [
      { ...template, id: `template.docx.${"b".repeat(64)}`, origin: "custom", is_default: true },
      template,
    ];
    const before = structuredClone(items);
    clientTesting.validateTemplateResources(items, "docx");
    expect(items).toEqual(before);
  });

  it.each([
    { origin: undefined },
    { origin: "local" },
    { is_default: undefined },
    { is_default: "false" },
    { id: "Standard" },
    { target: "xlsx" },
    { name: undefined },
  ])("rejects malformed template metadata %j", (change) => {
    expect(() => clientTesting.validateTemplateResources([{ ...template, ...change }])).toThrow(
      "Invalid or ambiguous template resource metadata",
    );
  });

  it("rejects duplicate IDs, multiple defaults, and mismatched requested format", () => {
    expect(() => clientTesting.validateTemplateResources([template, template])).toThrow();
    expect(() =>
      clientTesting.validateTemplateResources([
        { ...template, is_default: true },
        { ...template, id: `template.docx.${"b".repeat(64)}`, is_default: true },
      ]),
    ).toThrow();
    expect(() => clientTesting.validateTemplateResources([template], "xlsx")).toThrow();
  });
});
