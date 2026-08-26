import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";

import { docwenConfigSchema, SUPPORTED_LANGUAGES } from "./config.js";

describe("DocWen plugin configuration", () => {
  it("accepts only the current closed configuration shape", () => {
    expect(
      Check(docwenConfigSchema, {
        binaryPath: "C:\\DocWen\\DocWenCLI.exe",
        language: "zh_CN",
        readTimeoutMs: 1_000,
        writeTimeoutMs: 1_800_000,
      }),
    ).toBe(true);
    expect(Check(docwenConfigSchema, { language: "legacy", unknown: true })).toBe(false);
    expect(Check(docwenConfigSchema, { readTimeoutMs: 999 })).toBe(false);
    expect(Check(docwenConfigSchema, { writeTimeoutMs: 1_800_001 })).toBe(false);
  });

  it("keeps the schema language union aligned with the public catalogue", () => {
    for (const language of SUPPORTED_LANGUAGES) {
      expect(Check(docwenConfigSchema, { language })).toBe(true);
    }
  });
});
