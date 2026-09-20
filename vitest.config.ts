import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "scripts/**/*.test.mjs"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/docwen/test-fixtures.ts"],
      reporter: ["text", "json-summary"],
      thresholds: {
        statements: 67,
        branches: 73,
        functions: 76,
        lines: 67,
      },
    },
  },
});
