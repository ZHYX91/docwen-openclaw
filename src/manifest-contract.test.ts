import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { READ_TOOL_NAMES, TOOL_NAMES, WRITE_TOOL_NAMES } from "./tools/catalog.js";

const manifestPath = fileURLToPath(new URL("../openclaw.plugin.json", import.meta.url));
const packagePath = fileURLToPath(new URL("../package.json", import.meta.url));
const readmePath = fileURLToPath(new URL("../README.md", import.meta.url));
const skillPath = fileURLToPath(new URL("../skills/docwen/SKILL.md", import.meta.url));

describe("package and manifest contracts", () => {
  it("publishes exactly the frozen ten tools", () => {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      version: string;
      contracts: { tools: string[] };
      toolMetadata: Record<string, { optional?: boolean; replaySafe?: boolean }>;
      configSchema: { required?: string[]; properties: Record<string, unknown> };
    };
    expect(manifest.contracts.tools).toEqual(TOOL_NAMES);
    expect(manifest.version).toBe("3.0.0");
    expect(manifest.configSchema.required ?? []).not.toContain("binaryPath");
    expect(manifest.configSchema.properties.binaryPath).toEqual({ type: "string", minLength: 1 });
    expect(Object.keys(manifest.toolMetadata)).toEqual(TOOL_NAMES);
    for (const name of READ_TOOL_NAMES) expect(manifest.toolMetadata[name]).toEqual({ replaySafe: true });
    for (const name of WRITE_TOOL_NAMES) expect(manifest.toolMetadata[name]).toEqual({ optional: true });
  });

  it("uses the repository root as the package root", () => {
    const pkg = JSON.parse(readFileSync(packagePath, "utf8")) as {
      version: string;
      type: string;
      files: string[];
      openclaw: { extensions: string[]; compat: { pluginApi: string } };
    };
    expect(pkg.version).toBe("3.0.0");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { version: string };
    expect(pkg.version).toBe(manifest.version);
    expect(pkg.type).toBe("module");
    expect(pkg.files).toEqual(
      expect.arrayContaining(["dist", "openclaw.plugin.json", "skills", "README.md", "LICENSE"]),
    );
    expect(pkg.openclaw.extensions).toEqual(["./dist/index.js"]);
    expect(pkg.openclaw.compat.pluginApi).toBe(">=2026.7.1-2 <2027.0.0");
  });

  it("keeps the public documentation on the frozen tool catalog", () => {
    for (const path of [readmePath, skillPath]) {
      const names = [...readFileSync(path, "utf8").matchAll(/\bdocwen_[a-z_]+\b/g)].map(([name]) => name);
      expect([...new Set(names)].sort()).toEqual([...TOOL_NAMES].sort());
    }
  });
});
