import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { resolveDocWenBinary } from "./path.js";
import type * as PackagedMachineClient from "./machine-client.js";
import { NEUTRAL_DOCUMENT, NUMBERING_PLAN } from "./fixtures.generated.js";

const candidate = process.env.DOCWEN_MACHINE_D2_CANDIDATE;
const pluginRoot = process.env.DOCWEN_PLUGIN_D2_ROOT;
if (candidate && !pluginRoot) throw new Error("Packaged acceptance requires the verified plugin archive.");
const packagedClient: typeof PackagedMachineClient | undefined = candidate
  ? await import(pathToFileURL(join(pluginRoot!, "dist/docwen/machine-client.js")).href)
  : undefined;

const NEUTRAL_JSON = JSON.stringify(NEUTRAL_DOCUMENT);
const PLAN_JSON = JSON.stringify(NUMBERING_PLAN);

const neutralInput = (neutral: object) => ({
  input_id: "input.neutral-document",
  locator: { kind: "local_path" as const, path: "" },
  kind: "document" as const,
  role: "neutral_document" as const,
  logical_path: "inputs/document.resolved.json",
  media_type: "application/vnd.docwen.resolved-document+json",
  size_bytes: Buffer.byteLength(JSON.stringify(neutral)),
  sha256: createHash("sha256").update(JSON.stringify(neutral)).digest("hex"),
});

const planInput = {
  input_id: "input.numbering-export-plan",
  locator: { kind: "local_path" as const, path: "" },
  kind: "resource" as const,
  role: "numbering_export_plan" as const,
  logical_path: "inputs/numbering-export-plan.json",
  media_type: "application/vnd.docwen.numbering-export-plan+json",
  size_bytes: Buffer.byteLength(PLAN_JSON),
  sha256: createHash("sha256").update(PLAN_JSON).digest("hex"),
};

describe.skipIf(!candidate)("DocWen Machine Protocol v2 packaged exact-two client", () => {
  it("round-trips a resolved document and DOCX through the packaged machine protocol", async () => {
    const binaryPath = await resolveDocWenBinary(candidate!);
    const root = await mkdtemp(join(tmpdir(), "docwen-machine-client-"));
    try {
      const neutralPath = join(root, "neutral.json");
      const planPath = join(root, "plan.json");
      const staging = join(root, "staging");
      await writeFile(neutralPath, NEUTRAL_JSON);
      await writeFile(planPath, PLAN_JSON);
      await mkdir(staging);

      const result = await packagedClient!.runDocWenMachineTask({
        binaryPath,
        timeoutMs: 60_000,
        request: {
          capability_id: "convert.markdown.to_docx",
          inputs: [
            { ...neutralInput(NEUTRAL_DOCUMENT), locator: { kind: "local_path", path: neutralPath } },
            { ...planInput, locator: { kind: "local_path", path: planPath } },
          ],
          output: {
            staging_root: { kind: "local_path", path: staging },
            staging_policy: "require_empty",
          },
          options: {},
        },
      });

      const artifact = result.bundle.artifacts[0];
      expect(artifact?.kind).toBe("document");
      const output = await readFile(artifact!.absolutePath);
      expect(output.length).toBe(artifact!.size_bytes);
      expect(createHash("sha256").update(output).digest("hex")).toBe(artifact!.sha256);
      expect(result.progress.length).toBeGreaterThan(0);

      const markdownStaging = join(root, "markdown-staging");
      await mkdir(markdownStaging);
      const roundTrip = await packagedClient!.runDocWenMachineTask({
        binaryPath,
        timeoutMs: 60_000,
        request: {
          capability_id: "convert.docx.to_markdown",
          inputs: [
            {
              input_id: "input.2",
              locator: { kind: "local_path", path: join(staging, artifact!.locator) },
              kind: "document",
              role: "source",
              logical_path: "round-trip/output.docx",
              media_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
              size_bytes: output.length,
              sha256: createHash("sha256").update(output).digest("hex"),
            },
          ],
          output: {
            staging_root: { kind: "local_path", path: markdownStaging },
            staging_policy: "require_empty",
          },
          options: {},
        },
      });

      const markdownArtifact = roundTrip.bundle.artifacts[0];
      expect(markdownArtifact?.media_type).toBe("text/markdown");
      const markdown = await readFile(markdownArtifact!.absolutePath);
      const text = markdown.toString("utf8");
      expect(text).toContain("Architecture ^h-7f3a");
      expect(text).toContain("Figure: System overview ^system-overview");
      expect(createHash("sha256").update(markdown).digest("hex")).toBe(markdownArtifact!.sha256);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);

  it("rejects a resolved document whose embedded resource bytes were swapped", async () => {
    const binaryPath = await resolveDocWenBinary(candidate!);
    const root = await mkdtemp(join(tmpdir(), "docwen-machine-d2-decoy-"));
    const neutralPath = join(root, "neutral.json");
    const planPath = join(root, "plan.json");
    const staging = join(root, "staging");
    await mkdir(staging);

    const tampered = structuredClone(NEUTRAL_DOCUMENT);
    const image = tampered.document.resources.find(
      (r: { resource_id: string }) => r.resource_id === "image-system",
    );
    expect(image).toBeDefined();
    if (!image) throw new Error("fixture missing image-system resource");
    image.content_base64 = Buffer.from("not the declared image bytes", "utf8").toString("base64");

    await writeFile(neutralPath, JSON.stringify(tampered));
    await writeFile(planPath, PLAN_JSON);

    try {
      await packagedClient!.runDocWenMachineTask({
        binaryPath,
        timeoutMs: 60_000,
        request: {
          capability_id: "convert.markdown.to_docx",
          inputs: [
            { ...neutralInput(tampered), locator: { kind: "local_path", path: neutralPath } },
            { ...planInput, locator: { kind: "local_path", path: planPath } },
          ],
          output: {
            staging_root: { kind: "local_path", path: staging },
            staging_policy: "require_empty",
          },
          options: {},
        },
      });
      expect.fail("expected task to be rejected");
    } catch (error) {
      expect(String(error)).toMatch(/resource|integrity|sha256|binding/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});
