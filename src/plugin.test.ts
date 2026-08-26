import { describe, expect, it } from "vitest";

import defaultPlugin from "./index.js";
import { docwenPlugin } from "./plugin.js";

describe("plugin entry point", () => {
  it("exports the single current plugin definition", () => {
    expect(defaultPlugin).toBe(docwenPlugin);
    expect(docwenPlugin).toBeTruthy();
  });
});
