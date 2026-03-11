import { spawn } from "child_process";
import * as path from "path";
import { Type } from "@sinclair/typebox";
import { DocWenBinaryManager, DocWenPluginConfig } from "./binary-manager";

type OpenClawToolResult = { content: Array<{ type: "text"; text: string }> };

function getPluginConfig(api: any): DocWenPluginConfig {
  const cfg = api?.config?.plugins?.entries?.docwen?.config ?? {};
  return cfg as DocWenPluginConfig;
}

function formatExecError(e: any): string {
  const msg = String(e?.message || e || "error");
  if (msg === "docwen_cli_not_found_download_disabled") {
    return "DocWenCLI 未找到，且已禁用自动下载。请在插件配置中设置 binaryPath，或启用 allowDownload。";
  }
  if (msg === "docwen_release_tag_required") {
    return "未配置 releaseTag，无法自动下载 DocWenCLI。请在插件配置中设置 releaseTag，或设置 binaryPath。";
  }
  if (msg === "docwen_platform_unsupported") {
    return `当前平台不受支持：${process.platform}/${process.arch}。`;
  }
  if (msg === "docwen_cli_not_found") {
    return "未找到 DocWenCLI。请在插件配置中设置 binaryPath，或配置 releaseTag 并启用 allowDownload 以自动下载。";
  }
  if (msg === "docwen_archive_sha256_mismatch") {
    return "下载的 DocWenCLI 压缩包校验失败（SHA256 不匹配）。请检查 releaseTag/asset 名称是否一致，或重新下载。";
  }
  if (msg === "docwen_checksums_missing_asset") {
    return "SHA256SUMS.txt 中未找到对应资产的校验值。请确认 Release 同时上传了压缩包与 SHA256SUMS.txt，且文件名完全一致。";
  }
  if (msg === "docwen_archive_format_unsupported") {
    return "下载的资产格式不受支持。请使用 .zip（Windows）或 .tar.gz（Linux）的 Release 资产。";
  }
  if (msg === "docwen_extracted_binary_missing") {
    return "解压后未找到 DocWenCLI 可执行文件。请确认 Release 资产内包含 DocWenCLI（或 DocWenCLI.exe）并位于压缩包根目录。";
  }
  if (msg === "docwen_zip_missing_binary") {
    return "zip 内未找到 DocWenCLI 可执行文件。请确认 Release 资产结构正确。";
  }
  if (msg === "docwen_zip_missing_internal" || msg === "docwen_tar_missing_internal") {
    return "压缩包内缺少 _internal/ 目录。若使用 PyInstaller --onedir，必须完整打包 _internal/。";
  }
  if (msg === "docwen_zip_missing_templates" || msg === "docwen_tar_missing_templates") {
    return "压缩包内缺少 templates/ 目录。请确认 Release 资产包含模板文件。";
  }
  if (msg === "docwen_zip_missing_configs" || msg === "docwen_tar_missing_configs") {
    return "压缩包内缺少 configs/ 目录。请确认 Release 资产包含默认配置文件。";
  }
  if (msg === "docwen_zip_missing_locales" || msg === "docwen_tar_missing_locales") {
    return "压缩包内缺少 docwen/i18n/locales/ 目录。请确认 Release 资产包含语言包文件。";
  }
  if (msg === "docwen_tar_missing_binary") {
    return "tar.gz 内未找到 DocWenCLI 可执行文件。请确认 Release 资产结构正确。";
  }
  if (msg === "download_timeout") {
    return "下载 DocWenCLI 超时。可稍后重试，或改用 binaryPath 手工指定本地 DocWenCLI。";
  }
  if (msg === "download_redirects_exceeded") {
    return "下载 DocWenCLI 失败：重定向次数过多。请检查网络环境或 Release 地址是否正常。";
  }
  if (msg === "download_redirect_invalid_location") {
    return "下载 DocWenCLI 失败：重定向地址无效。请检查网络环境或 Release 地址是否正常。";
  }
  if (msg.startsWith("download_failed_")) {
    return `下载 DocWenCLI 失败：${msg.replace(/^download_failed_/, "")}。请检查网络环境或 Release 地址是否正常。`;
  }
  if (msg.startsWith("invalid_json")) {
    return "DocWenCLI 输出不是有效 JSON（请确认使用 --json 且 stdout 未被污染）。";
  }
  return `执行失败：${msg}`;
}

function resolveLang(cfg: DocWenPluginConfig): string | null {
  const lang = String(cfg.lang || "").trim();
  return lang || null;
}

async function runDocwenJson(opts: {
  binaryPath: string;
  lang?: string | null;
  args: string[];
}): Promise<any> {
  const args: string[] = [...opts.args];
  if (opts.lang && !args.includes("--lang") && !args.some((a) => a.startsWith("--lang="))) {
    args.push("--lang", opts.lang);
  }
  if (!args.includes("--json")) args.push("--json");
  if (!args.includes("--quiet") && !args.includes("-q")) args.push("--quiet");

  return await new Promise((resolve, reject) => {
    const child = spawn(opts.binaryPath, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));

    child.on("error", (e) => reject(e));
    child.on("close", (code) => {
      const out = stdout.trim();
      if (!out) {
        reject(new Error(stderr || `empty_stdout (code=${code ?? "unknown"})`));
        return;
      }
      try {
        resolve(JSON.parse(out));
      } catch {
        reject(new Error(`invalid_json: ${out.slice(0, 800)}`));
      }
    });
  });
}

function stringifyTrimmed(obj: any, maxChars: number): string {
  const s = JSON.stringify(obj, null, 2);
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars) + "\n...\n";
}

function formatResultSummary(result: any): string {
  const ok = result?.success === true;
  const cmd = String(result?.command || "").trim() || "docwen";
  if (ok) {
    const data = result?.data ?? {};
    const out = String(data?.output_file || data?.outputFile || "").trim();
    if (out) return `${cmd}: ok\noutput: ${out}`;
    return `${cmd}: ok`;
  }
  const err = result?.error ?? {};
  const code = String(err?.error_code || result?.error_code || "error").trim() || "error";
  const msg = String(err?.message || result?.message || "").trim();
  return `${cmd}: failed\n${code}${msg ? `: ${msg}` : ""}`;
}

function normalizePaths(files: string[]): string[] {
  return files.map((p) => path.normalize(String(p || "").trim())).filter((p) => p.length > 0);
}

export default function register(api: any) {
  const manager = new DocWenBinaryManager();

  api.registerTool({
    name: "docwen_doctor",
    description: "Self-check DocWenCLI availability and configuration.",
    parameters: Type.Object({}),
    async execute() {
      try {
        const cfg = getPluginConfig(api);
        const binaryPath = await manager.resolveBinary(cfg);
        const result = await runDocwenJson({ binaryPath, lang: resolveLang(cfg), args: ["doctor"] });
        return {
          content: [
            { type: "text", text: formatResultSummary(result) },
            { type: "text", text: stringifyTrimmed(result, 6000) },
          ],
        } satisfies OpenClawToolResult;
      } catch (e: any) {
        return { content: [{ type: "text", text: formatExecError(e) }] } satisfies OpenClawToolResult;
      }
    },
  });

  api.registerTool({
    name: "docwen_inspect",
    description: "Inspect a file category/format and supported actions.",
    parameters: Type.Object({ file: Type.String({ minLength: 1 }) }),
    async execute(_id: string, params: { file: string }) {
      try {
        const cfg = getPluginConfig(api);
        const binaryPath = await manager.resolveBinary(cfg);
        const file = path.normalize(String(params.file).trim());
        const result = await runDocwenJson({ binaryPath, lang: resolveLang(cfg), args: ["inspect", file] });
        return {
          content: [
            { type: "text", text: formatResultSummary(result) },
            { type: "text", text: stringifyTrimmed(result, 6000) },
          ],
        } satisfies OpenClawToolResult;
      } catch (e: any) {
        return { content: [{ type: "text", text: formatExecError(e) }] } satisfies OpenClawToolResult;
      }
    },
  });

  api.registerTool({
    name: "docwen_templates",
    description: "List available templates (docx/xlsx).",
    parameters: Type.Object({ for: Type.Optional(Type.Union([Type.Literal("docx"), Type.Literal("xlsx")])) }),
    async execute(_id: string, params: { for?: "docx" | "xlsx" }) {
      try {
        const cfg = getPluginConfig(api);
        const binaryPath = await manager.resolveBinary(cfg);
        const args: string[] = ["templates", "list"];
        if (params.for) args.push("--for", params.for);
        const result = await runDocwenJson({ binaryPath, lang: resolveLang(cfg), args });
        return {
          content: [
            { type: "text", text: formatResultSummary(result) },
            { type: "text", text: stringifyTrimmed(result, 6000) },
          ],
        } satisfies OpenClawToolResult;
      } catch (e: any) {
        return { content: [{ type: "text", text: formatExecError(e) }] } satisfies OpenClawToolResult;
      }
    },
  });

  api.registerTool({
    name: "docwen_optimizations",
    description: "List available optimization types for a given scope.",
    parameters: Type.Object({ scope: Type.Optional(Type.String({ minLength: 1 })) }),
    async execute(_id: string, params: { scope?: string }) {
      try {
        const cfg = getPluginConfig(api);
        const binaryPath = await manager.resolveBinary(cfg);
        const args: string[] = ["optimizations", "list"];
        const scope = String(params.scope || "").trim();
        if (scope) args.push("--scope", scope);
        const result = await runDocwenJson({ binaryPath, lang: resolveLang(cfg), args });
        return {
          content: [
            { type: "text", text: formatResultSummary(result) },
            { type: "text", text: stringifyTrimmed(result, 6000) },
          ],
        } satisfies OpenClawToolResult;
      } catch (e: any) {
        return { content: [{ type: "text", text: formatExecError(e) }] } satisfies OpenClawToolResult;
      }
    },
  });

  api.registerTool({
    name: "docwen_formats",
    description: "List available target formats (optionally filtered by source category).",
    parameters: Type.Object({
      for: Type.Optional(
        Type.Union([
          Type.Literal("document"),
          Type.Literal("spreadsheet"),
          Type.Literal("layout"),
          Type.Literal("image"),
          Type.Literal("markdown"),
        ]),
      ),
    }),
    async execute(_id: string, params: { for?: "document" | "spreadsheet" | "layout" | "image" | "markdown" }) {
      try {
        const cfg = getPluginConfig(api);
        const binaryPath = await manager.resolveBinary(cfg);
        const args: string[] = ["formats", "list"];
        if (params.for) args.push("--for", params.for);
        const result = await runDocwenJson({ binaryPath, lang: resolveLang(cfg), args });
        return {
          content: [
            { type: "text", text: formatResultSummary(result) },
            { type: "text", text: stringifyTrimmed(result, 12000) },
          ],
        } satisfies OpenClawToolResult;
      } catch (e: any) {
        return { content: [{ type: "text", text: formatExecError(e) }] } satisfies OpenClawToolResult;
      }
    },
  });

  api.registerTool({
    name: "docwen_actions",
    description: "List available actions.",
    parameters: Type.Object({}),
    async execute() {
      try {
        const cfg = getPluginConfig(api);
        const binaryPath = await manager.resolveBinary(cfg);
        const result = await runDocwenJson({ binaryPath, lang: resolveLang(cfg), args: ["actions", "list"] });
        return {
          content: [
            { type: "text", text: formatResultSummary(result) },
            { type: "text", text: stringifyTrimmed(result, 12000) },
          ],
        } satisfies OpenClawToolResult;
      } catch (e: any) {
        return { content: [{ type: "text", text: formatExecError(e) }] } satisfies OpenClawToolResult;
      }
    },
  });

  api.registerTool({
    name: "docwen_numbering_schemes",
    description: "List available numbering schemes.",
    parameters: Type.Object({}),
    async execute() {
      try {
        const cfg = getPluginConfig(api);
        const binaryPath = await manager.resolveBinary(cfg);
        const result = await runDocwenJson({ binaryPath, lang: resolveLang(cfg), args: ["numbering-schemes", "list"] });
        return {
          content: [
            { type: "text", text: formatResultSummary(result) },
            { type: "text", text: stringifyTrimmed(result, 12000) },
          ],
        } satisfies OpenClawToolResult;
      } catch (e: any) {
        return { content: [{ type: "text", text: formatExecError(e) }] } satisfies OpenClawToolResult;
      }
    },
  });

  api.registerTool({
    name: "docwen_merge_images_to_tiff",
    description: "Merge images to a single TIFF.",
    parameters: Type.Object({
      files: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
      keep_alpha: Type.Optional(Type.Boolean()),
      compress: Type.Optional(Type.Union([Type.Literal("lossless"), Type.Literal("limit_size")])),
      size_limit: Type.Optional(Type.Integer({ minimum: 1 })),
      quality_mode: Type.Optional(Type.Union([Type.Literal("original"), Type.Literal("a4"), Type.Literal("a3")])),
    }),
    async execute(
      _id: string,
      params: {
        files: string[];
        keep_alpha?: boolean;
        compress?: "lossless" | "limit_size";
        size_limit?: number;
        quality_mode?: "original" | "a4" | "a3";
      },
    ) {
      try {
        const cfg = getPluginConfig(api);
        const binaryPath = await manager.resolveBinary(cfg);
        const files = normalizePaths(params.files);
        const args: string[] = ["merge-images-to-tiff", ...files];
        if (params.keep_alpha === true) args.push("--keep-alpha");
        if (params.compress) args.push("--compress", params.compress);
        if (typeof params.size_limit === "number" && Number.isFinite(params.size_limit)) {
          args.push("--size-limit", String(params.size_limit));
        }
        if (params.quality_mode) args.push("--quality-mode", params.quality_mode);
        const result = await runDocwenJson({ binaryPath, lang: resolveLang(cfg), args });
        return {
          content: [
            { type: "text", text: formatResultSummary(result) },
            { type: "text", text: stringifyTrimmed(result, 12000) },
          ],
        } satisfies OpenClawToolResult;
      } catch (e: any) {
        return { content: [{ type: "text", text: formatExecError(e) }] } satisfies OpenClawToolResult;
      }
    },
  });

  api.registerTool({
    name: "docwen_md_numbering",
    description: "Clean/add heading numbering for Markdown files.",
    parameters: Type.Object({
      files: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
      clean_numbering: Type.Optional(Type.Union([Type.Literal("default"), Type.Literal("remove"), Type.Literal("keep")])),
      add_numbering: Type.Optional(Type.String({ minLength: 1 })),
    }),
    async execute(
      _id: string,
      params: {
        files: string[];
        clean_numbering?: "default" | "remove" | "keep";
        add_numbering?: string;
      },
    ) {
      try {
        const cfg = getPluginConfig(api);
        const binaryPath = await manager.resolveBinary(cfg);
        const files = normalizePaths(params.files);
        const args: string[] = ["md-numbering", ...files];
        if (params.clean_numbering) args.push("--clean-numbering", params.clean_numbering);
        const addNumbering = String(params.add_numbering || "").trim();
        if (addNumbering) args.push("--add-numbering", addNumbering);
        const result = await runDocwenJson({ binaryPath, lang: resolveLang(cfg), args });
        return {
          content: [
            { type: "text", text: formatResultSummary(result) },
            { type: "text", text: stringifyTrimmed(result, 12000) },
          ],
        } satisfies OpenClawToolResult;
      } catch (e: any) {
        return { content: [{ type: "text", text: formatExecError(e) }] } satisfies OpenClawToolResult;
      }
    },
  });

  api.registerTool({
    name: "docwen_convert",
    description: "Convert files to a target format (md/docx/xlsx/pdf etc.).",
    parameters: Type.Object({
      files: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
      to: Type.String({ minLength: 1 }),
      template: Type.Optional(Type.String({ minLength: 1 })),
      extract_img: Type.Optional(Type.Boolean()),
      ocr: Type.Optional(Type.Boolean()),
      optimize_for: Type.Optional(Type.String({ minLength: 1 })),
      clean_numbering: Type.Optional(Type.Union([Type.Literal("default"), Type.Literal("remove"), Type.Literal("keep")])),
      add_numbering: Type.Optional(Type.String({ minLength: 1 })),
      batch: Type.Optional(Type.Boolean()),
      jobs: Type.Optional(Type.Integer({ minimum: 1, maximum: 32 })),
      continue_on_error: Type.Optional(Type.Boolean()),
      yes: Type.Optional(Type.Boolean()),
    }),
    async execute(
      _id: string,
      params: {
        files: string[];
        to: string;
        template?: string;
        extract_img?: boolean;
        ocr?: boolean;
        optimize_for?: string;
        clean_numbering?: "default" | "remove" | "keep";
        add_numbering?: string;
        batch?: boolean;
        jobs?: number;
        continue_on_error?: boolean;
        yes?: boolean;
      },
    ) {
      try {
        const cfg = getPluginConfig(api);
        const binaryPath = await manager.resolveBinary(cfg);

        const files = normalizePaths(params.files);
        const to = String(params.to).trim();
        const args: string[] = ["convert", ...files, "--to", to];

        const template = String(params.template || "").trim();
        if (template) args.push("--template", template);

        if (typeof params.extract_img === "boolean") {
          args.push(params.extract_img ? "--extract-img" : "--no-extract-img");
        }
        if (params.ocr === true) args.push("--ocr");

        const optimizeFor = String(params.optimize_for || "").trim();
        if (optimizeFor) args.push("--optimize-for", optimizeFor);

        if (params.clean_numbering) args.push("--clean-numbering", params.clean_numbering);
        const addNumbering = String(params.add_numbering || "").trim();
        if (addNumbering) args.push("--add-numbering", addNumbering);

        if (params.batch === true) args.push("--batch");
        if (params.yes === true) args.push("--yes");
        if (params.continue_on_error === true) args.push("--continue-on-error");
        if (typeof params.jobs === "number" && Number.isFinite(params.jobs)) args.push("--jobs", String(params.jobs));

        const result = await runDocwenJson({ binaryPath, lang: resolveLang(cfg), args });
        return {
          content: [
            { type: "text", text: formatResultSummary(result) },
            { type: "text", text: stringifyTrimmed(result, 12000) },
          ],
        } satisfies OpenClawToolResult;
      } catch (e: any) {
        return { content: [{ type: "text", text: formatExecError(e) }] } satisfies OpenClawToolResult;
      }
    },
  });

  api.registerTool({
    name: "docwen_validate",
    description: "Proofread documents with specified checks.",
    parameters: Type.Object({
      files: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
      checks: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    }),
    async execute(_id: string, params: { files: string[]; checks: string[] }) {
      try {
        const cfg = getPluginConfig(api);
        const binaryPath = await manager.resolveBinary(cfg);
        const files = normalizePaths(params.files);
        const args: string[] = ["validate", ...files];
        for (const c of params.checks) {
          const check = String(c || "").trim();
          if (check) args.push("--check", check);
        }
        const result = await runDocwenJson({ binaryPath, lang: resolveLang(cfg), args });
        return {
          content: [
            { type: "text", text: formatResultSummary(result) },
            { type: "text", text: stringifyTrimmed(result, 12000) },
          ],
        } satisfies OpenClawToolResult;
      } catch (e: any) {
        return { content: [{ type: "text", text: formatExecError(e) }] } satisfies OpenClawToolResult;
      }
    },
  });

  api.registerTool({
    name: "docwen_merge_pdfs",
    description: "Merge PDF/OFD/XPS files.",
    parameters: Type.Object({ files: Type.Array(Type.String({ minLength: 1 }), { minItems: 2 }) }),
    async execute(_id: string, params: { files: string[] }) {
      try {
        const cfg = getPluginConfig(api);
        const binaryPath = await manager.resolveBinary(cfg);
        const files = normalizePaths(params.files);
        const result = await runDocwenJson({ binaryPath, lang: resolveLang(cfg), args: ["merge-pdfs", ...files] });
        return {
          content: [
            { type: "text", text: formatResultSummary(result) },
            { type: "text", text: stringifyTrimmed(result, 12000) },
          ],
        } satisfies OpenClawToolResult;
      } catch (e: any) {
        return { content: [{ type: "text", text: formatExecError(e) }] } satisfies OpenClawToolResult;
      }
    },
  });

  api.registerTool({
    name: "docwen_split_pdf",
    description: "Split a PDF by page ranges.",
    parameters: Type.Object({
      file: Type.String({ minLength: 1 }),
      pages: Type.String({ minLength: 1 }),
      dpi: Type.Optional(Type.Union([Type.Literal(150), Type.Literal(300), Type.Literal(600)])),
    }),
    async execute(_id: string, params: { file: string; pages: string; dpi?: 150 | 300 | 600 }) {
      try {
        const cfg = getPluginConfig(api);
        const binaryPath = await manager.resolveBinary(cfg);
        const file = path.normalize(String(params.file).trim());
        const pages = String(params.pages).trim();
        const args: string[] = ["split-pdf", file, "--pages", pages];
        if (typeof params.dpi === "number") args.push("--dpi", String(params.dpi));
        const result = await runDocwenJson({
          binaryPath,
          lang: resolveLang(cfg),
          args,
        });
        return {
          content: [
            { type: "text", text: formatResultSummary(result) },
            { type: "text", text: stringifyTrimmed(result, 12000) },
          ],
        } satisfies OpenClawToolResult;
      } catch (e: any) {
        return { content: [{ type: "text", text: formatExecError(e) }] } satisfies OpenClawToolResult;
      }
    },
  });

  api.registerTool({
    name: "docwen_merge_tables",
    description: "Merge spreadsheet tables.",
    parameters: Type.Object({
      files: Type.Array(Type.String({ minLength: 1 }), { minItems: 2 }),
      mode: Type.Union([Type.Literal("row"), Type.Literal("col"), Type.Literal("cell")]),
      base_table: Type.Optional(Type.String({ minLength: 1 })),
    }),
    async execute(_id: string, params: { files: string[]; mode: "row" | "col" | "cell"; base_table?: string }) {
      try {
        const cfg = getPluginConfig(api);
        const binaryPath = await manager.resolveBinary(cfg);
        const files = normalizePaths(params.files);
        const args: string[] = ["merge-tables", ...files];
        args.push("--mode", params.mode);
        const baseTable = String(params.base_table || "").trim();
        if (baseTable) args.push("--base-table", baseTable);
        const result = await runDocwenJson({ binaryPath, lang: resolveLang(cfg), args });
        return {
          content: [
            { type: "text", text: formatResultSummary(result) },
            { type: "text", text: stringifyTrimmed(result, 12000) },
          ],
        } satisfies OpenClawToolResult;
      } catch (e: any) {
        return { content: [{ type: "text", text: formatExecError(e) }] } satisfies OpenClawToolResult;
      }
    },
  });
}
