import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import process from "node:process";
import { URL, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { createReleaseWork, finishReleaseWork } from "./release-work.mjs";

describe("repository check npm dispatch", () => {
  it("preserves the initiating CLI through real lifecycle, build and source subgates", () => {
    const runScript = createRequire(process.env.npm_execpath).resolve("@npmcli/run-script");
    const work = createReleaseWork(process.cwd());
    let success = false;
    try {
      const npmCli = join(work.root, "initiating-npm.mjs");
      writeFileSync(
        npmCli,
        [
          `import runScript from ${JSON.stringify(pathToFileURL(runScript).href)};`,
          'import { appendFileSync, readFileSync } from "node:fs";',
          'import { fileURLToPath } from "node:url";',
          'import process from "node:process";',
          "const args = process.argv.slice(2);",
          'if (args[0] === "--version") process.stdout.write("11.17.0\\n");',
          'else if (args[0] === "audit") appendFileSync("audit.jsonl", JSON.stringify(args) + "\\n");',
          'else if (args[0] === "run") {',
          '  try { await runScript({ event: args[1], path: process.cwd(), pkg: JSON.parse(readFileSync("package.json", "utf8")), env: { ...process.env, npm_execpath: fileURLToPath(import.meta.url), npm_node_execpath: process.execPath }, stdio: "inherit" }); }',
          "  catch (error) { process.exitCode = Number.isInteger(error.code) ? error.code : 1; }",
          "} else process.exitCode = 1;",
        ].join("\n"),
      );
      const results = [];
      for (const event of ["prepack", "build", "audit:prod", "check:source"]) {
        const repo = join(work.root, event.replaceAll(":", "-"));
        const bin = join(repo, "node_modules", ".bin");
        mkdirSync(bin, { recursive: true });
        mkdirSync(join(repo, "node_modules", "openclaw"));
        mkdirSync(join(repo, "node_modules", "typescript", "bin"), { recursive: true });
        mkdirSync(join(repo, "scripts"));
        const pkg = JSON.parse(readFileSync("package.json", "utf8"));
        for (const leaf of ["lint", "format:check", "typecheck", "test:coverage", "clean", "package:check"]) {
          pkg.scripts[leaf] = `node scripts/probe.mjs ${leaf}`;
        }
        writeFileSync(join(repo, "package.json"), JSON.stringify(pkg));
        writeFileSync(join(repo, "package-lock.json"), readFileSync("package-lock.json"));
        writeFileSync(
          join(repo, "node_modules", "openclaw", "package.json"),
          readFileSync("node_modules/openclaw/package.json"),
        );
        const shim = process.platform === "win32" ? "npm.cmd" : "npm";
        writeFileSync(
          join(bin, shim),
          process.platform === "win32"
            ? "@echo hijacked>hijacked\r\n@exit /b 49\r\n"
            : "#!/bin/sh\necho hijacked>hijacked\nexit 49\n",
          { mode: 0o755 },
        );
        writeFileSync(
          join(repo, "scripts", "run-check.mjs"),
          [
            `import { runRepositoryChecks } from ${JSON.stringify(new URL("./run-check.mjs", import.meta.url).href)};`,
            'import process from "node:process";',
            'process.exitCode = runRepositoryChecks({ mode: process.argv[2] ?? "all" });',
          ].join("\n"),
        );
        writeFileSync(
          join(repo, "scripts", "probe.mjs"),
          'import { appendFileSync } from "node:fs"; import process from "node:process"; appendFileSync("steps.jsonl", JSON.stringify(process.argv[2]) + "\\n");',
        );
        writeFileSync(
          join(repo, "node_modules", "typescript", "bin", "tsc"),
          'require("node:fs").writeFileSync("compiled", "true");',
        );
        const result = spawnSync(process.execPath, [npmCli, "run", event], {
          cwd: repo,
          encoding: "utf8",
          timeout: 10_000,
          shell: false,
          windowsHide: true,
          env: Object.fromEntries(
            Object.entries(process.env).filter(
              ([name]) => !["npm_execpath", "npm_node_execpath"].includes(name.toLowerCase()),
            ),
          ),
        });
        writeFileSync(join(repo, "stdout.log"), result.stdout ?? "");
        writeFileSync(join(repo, "stderr.log"), result.stderr ?? "");
        const audited = existsSync(join(repo, "audit.jsonl"))
          ? readFileSync(join(repo, "audit.jsonl"), "utf8").trim().split("\n").map(JSON.parse)
          : [];
        results.push({
          event,
          status: result.status,
          hijacked: existsSync(join(repo, "hijacked")),
          audited,
          compiled: existsSync(join(repo, "compiled")),
        });
      }
      expect(results).toEqual([
        {
          event: "prepack",
          status: 0,
          hijacked: false,
          audited: [["audit", "--omit=dev", "--audit-level=high"]],
          compiled: true,
        },
        { event: "build", status: 0, hijacked: false, audited: [], compiled: true },
        {
          event: "audit:prod",
          status: 0,
          hijacked: false,
          audited: [["audit", "--omit=dev", "--audit-level=high"]],
          compiled: false,
        },
        {
          event: "check:source",
          status: 0,
          hijacked: false,
          audited: [["audit", "--omit=dev", "--audit-level=high"]],
          compiled: false,
        },
      ]);
      success = true;
    } finally {
      finishReleaseWork(work, success);
    }
  }, 45_000);
});
