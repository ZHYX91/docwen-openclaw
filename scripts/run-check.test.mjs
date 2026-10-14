import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";
import { runRepositoryChecks } from "./run-check.mjs";
import { createReleaseWork, finishReleaseWork } from "./release-work.mjs";

describe("repository check npm dispatch", () => {
  it("uses the initiating npm CLI even when a dependency adds another npm to PATH", () => {
    const work = createReleaseWork(process.cwd());
    let success = false;
    try {
      const repo = join(work.root, "repository");
      const bin = join(repo, "node_modules", ".bin");
      mkdirSync(bin, { recursive: true });
      mkdirSync(join(repo, "node_modules", "openclaw"));
      for (const file of ["package.json", "package-lock.json"]) {
        writeFileSync(join(repo, file), readFileSync(file));
      }
      writeFileSync(
        join(repo, "node_modules", "openclaw", "package.json"),
        readFileSync("node_modules/openclaw/package.json"),
      );
      const hijacked = join(repo, "hijacked");
      const npmShim = process.platform === "win32" ? "npm.cmd" : "npm";
      writeFileSync(
        join(bin, npmShim),
        process.platform === "win32" ? "@echo hijacked>hijacked\r\n" : "#!/bin/sh\necho hijacked>hijacked\n",
        { mode: 0o755 },
      );
      const npmCli = join(work.root, "initiating-npm.mjs");
      writeFileSync(
        npmCli,
        [
          'import { appendFileSync } from "node:fs";',
          'import process from "node:process";',
          'if (process.argv[2] === "--version") process.stdout.write("11.17.0\\n");',
          'else appendFileSync("steps.jsonl", JSON.stringify(process.argv.slice(2)) + "\\n");',
        ].join("\n"),
      );
      const separator = process.platform === "win32" ? ";" : ":";
      const environment = Object.fromEntries(
        Object.entries(process.env).filter(([name]) => name.toUpperCase() !== "PATH"),
      );
      environment.PATH = `${bin}${separator}${process.env.PATH ?? process.env.Path ?? ""}`;
      expect(runRepositoryChecks({ repoRoot: repo, npmCli, environment })).toBe(0);
      expect(readFileSync(join(repo, "steps.jsonl"), "utf8").trim().split("\n").map(JSON.parse)).toEqual([
        ["run", "check:source"],
        ["run", "build"],
        ["run", "package:check"],
      ]);
      expect(existsSync(hijacked)).toBe(false);
      success = true;
    } finally {
      finishReleaseWork(work, success);
    }
  });
});
