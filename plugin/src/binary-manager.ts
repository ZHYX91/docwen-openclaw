import * as crypto from "crypto";
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as https from "https";
import AdmZip from "adm-zip";
import * as tar from "tar";

export type DocWenPluginConfig = {
  binaryPath?: string;
  lang?: string;
  allowDownload?: boolean;
  releaseRepo?: string;
  releaseTag?: string;
  windowsAsset?: string;
  linuxAsset?: string;
  checksumsAsset?: string;
  installDir?: string;
  downloadTimeoutMs?: number;
};

export class DocWenBinaryManager {
  private static readonly DOWNLOAD_TIMEOUT_MS = 180_000;
  private static readonly MAX_REDIRECTS = 10;
  async resolveBinary(cfg: DocWenPluginConfig): Promise<string> {
    const configured = this.normalizeOptionalPath(cfg.binaryPath);
    if (configured && (await this.isFile(configured))) return configured;

    const envPath = this.normalizeOptionalPath(process.env.DOCWENCLI_PATH);
    if (envPath && (await this.isFile(envPath))) return envPath;

    const cached = await this.resolveCachedBinary(cfg);
    if (cached) return cached;

    if (cfg.allowDownload === false) {
      throw new Error("docwen_cli_not_found_download_disabled");
    }

    await this.downloadAndInstall(cfg);
    const after = await this.resolveCachedBinary(cfg);
    if (after) return after;

    throw new Error("docwen_cli_not_found");
  }

  private async resolveCachedBinary(cfg: DocWenPluginConfig): Promise<string | null> {
    const tag = String(cfg.releaseTag || "").trim();
    if (!tag) return null;

    const installDir = this.getInstallDir(cfg);
    const dir = path.join(installDir, this.sanitizeTag(tag));
    const binaryName = this.getBinaryName();
    const candidate = path.join(dir, binaryName);
    if (await this.isFile(candidate)) return candidate;
    return null;
  }

  private getBinaryName(): string {
    if (process.platform === "win32") return "DocWenCLI.exe";
    return "DocWenCLI";
  }

  private getInstallDir(cfg: DocWenPluginConfig): string {
    const raw = String(cfg.installDir || "").trim();
    if (raw) return this.expandHome(raw);
    const base = String(process.env.OPENCLAW_STATE_DIR || "").trim() || path.join(os.homedir(), ".openclaw");
    return path.join(base, "tools", "docwen");
  }

  private sanitizeTag(tag: string): string {
    return tag.replace(/[^\w.\-]/g, "_");
  }

  private expandHome(p: string): string {
    const s = String(p || "").trim();
    if (!s) return s;
    if (s === "~") return os.homedir();
    if (s.startsWith("~/") || s.startsWith("~\\")) return path.join(os.homedir(), s.slice(2));
    return s;
  }

  private normalizeOptionalPath(p?: string): string | null {
    const raw = String(p || "").trim().replace(/^['"]|['"]$/g, "");
    if (!raw) return null;
    return path.normalize(this.expandHome(raw));
  }

  private async isFile(p: string): Promise<boolean> {
    try {
      return (await fsp.stat(p)).isFile();
    } catch {
      return false;
    }
  }

  private async downloadAndInstall(cfg: DocWenPluginConfig): Promise<void> {
    const tag = String(cfg.releaseTag || "").trim();
    if (!tag) throw new Error("docwen_release_tag_required");

    const repo = String(cfg.releaseRepo || "ZHYX91/docwen").trim();
    const asset = this.getArchiveAssetName(cfg);
    const checksumsAsset = String(cfg.checksumsAsset || "SHA256SUMS.txt").trim();

    const archiveUrl = `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(asset)}`;
    const sumsUrl = `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(checksumsAsset)}`;

    const installDir = this.getInstallDir(cfg);
    const destDir = path.join(installDir, this.sanitizeTag(tag));
    await fsp.mkdir(destDir, { recursive: true });

    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "docwen-openclaw-"));
    const archivePath = path.join(tmpDir, asset);
    const sumsPath = path.join(tmpDir, checksumsAsset);

    try {
      const timeoutMs = this.resolveDownloadTimeoutMs(cfg);
      await this.downloadToFile(sumsUrl, sumsPath, timeoutMs);
      const sums = await fsp.readFile(sumsPath, "utf-8");
      const expected = this.parseSha256Sums(sums).get(asset);
      if (!expected) throw new Error("docwen_checksums_missing_asset");

      await this.downloadToFile(archiveUrl, archivePath, timeoutMs);
      const actual = await this.sha256FileHex(archivePath);
      if (actual.toLowerCase() !== expected.toLowerCase()) {
        throw new Error("docwen_archive_sha256_mismatch");
      }

      await this.extractArchiveToDir(archivePath, destDir);
      const binaryPath = path.join(destDir, this.getBinaryName());
      if (!(await this.isFile(binaryPath))) throw new Error("docwen_extracted_binary_missing");
      if (process.platform !== "win32") {
        await fsp.chmod(binaryPath, 0o755);
      }
    } finally {
      await this.safeRm(tmpDir);
    }
  }

  private getArchiveAssetName(cfg: DocWenPluginConfig): string {
    if (process.platform === "win32") {
      if (process.arch !== "x64") throw new Error("docwen_platform_unsupported");
      return String(cfg.windowsAsset || "DocWenCLI-win-x64.zip").trim();
    }
    if (process.platform === "linux") {
      if (process.arch !== "x64") throw new Error("docwen_platform_unsupported");
      return String(cfg.linuxAsset || "DocWenCLI-linux-x64.tar.gz").trim();
    }
    throw new Error("docwen_platform_unsupported");
  }

  private async extractArchiveToDir(archivePath: string, destDir: string): Promise<void> {
    if (archivePath.toLowerCase().endsWith(".zip")) {
      await this.extractZip(archivePath, destDir);
      return;
    }
    if (archivePath.toLowerCase().endsWith(".tar.gz") || archivePath.toLowerCase().endsWith(".tgz")) {
      await this.extractTarGz(archivePath, destDir);
      return;
    }
    throw new Error("docwen_archive_format_unsupported");
  }

  private resolveDownloadTimeoutMs(cfg: DocWenPluginConfig): number {
    const v = cfg.downloadTimeoutMs;
    if (typeof v !== "number" || !Number.isFinite(v)) return DocWenBinaryManager.DOWNLOAD_TIMEOUT_MS;
    const ms = Math.floor(v);
    if (ms <= 0) return DocWenBinaryManager.DOWNLOAD_TIMEOUT_MS;
    return ms;
  }

  private async extractZip(archivePath: string, destDir: string): Promise<void> {
    const zip = new AdmZip(archivePath);
    const entries = zip.getEntries();
    const wantedExe = this.getBinaryName().replace(/\\/g, "/").toLowerCase();

    let wroteExe = false;
    let wroteInternal = false;
    let wroteTemplates = false;
    let wroteConfigs = false;
    let wroteLocales = false;

    for (const e of entries) {
      if (e.isDirectory) continue;

      const rawName = String(e.entryName || "").replace(/\\/g, "/");
      const name = rawName.replace(/^(\.\/)+/, "");
      const lower = name.toLowerCase();

      if (lower === wantedExe || lower.endsWith(`/${wantedExe}`)) {
        const outPath = path.join(destDir, this.getBinaryName());
        await fsp.writeFile(outPath, e.getData());
        wroteExe = true;
        continue;
      }

      const internalIdx = lower.indexOf("/_internal/");
      let internalRel: string | null = null;
      if (lower.startsWith("_internal/")) internalRel = name;
      else if (internalIdx >= 0) internalRel = name.slice(internalIdx + 1);

      const resourceRel = this.pickResourceRel(name);
      const rel = internalRel || resourceRel;
      if (!rel) continue;

      const safeRel = this.toSafePosixRel(rel);
      if (!safeRel) continue;

      const lowerRel = safeRel.toLowerCase();
      const allowed =
        lowerRel.startsWith("_internal/") ||
        lowerRel.startsWith("templates/") ||
        lowerRel.startsWith("configs/") ||
        lowerRel.startsWith("docwen/i18n/locales/");
      if (!allowed) continue;

      const outPath = path.join(destDir, ...safeRel.split("/"));
      await fsp.mkdir(path.dirname(outPath), { recursive: true });
      await fsp.writeFile(outPath, e.getData());
      if (lowerRel.startsWith("_internal/")) wroteInternal = true;
      else if (lowerRel.startsWith("templates/")) wroteTemplates = true;
      else if (lowerRel.startsWith("configs/")) wroteConfigs = true;
      else if (lowerRel.startsWith("docwen/i18n/locales/")) wroteLocales = true;
    }

    if (!wroteExe) throw new Error("docwen_zip_missing_binary");
    if (!wroteInternal || !(await this.existsDir(path.join(destDir, "_internal")))) {
      throw new Error("docwen_zip_missing_internal");
    }
    if (!wroteTemplates || !(await this.existsDir(path.join(destDir, "templates")))) {
      throw new Error("docwen_zip_missing_templates");
    }
    if (!wroteConfigs || !(await this.existsDir(path.join(destDir, "configs")))) {
      throw new Error("docwen_zip_missing_configs");
    }
    if (!wroteLocales || !(await this.existsDir(path.join(destDir, "docwen", "i18n", "locales")))) {
      throw new Error("docwen_zip_missing_locales");
    }
  }

  private getAllowedArchivePrefixes(): string[] {
    return ["_internal/", "templates/", "configs/", "docwen/i18n/locales/"];
  }

  private async extractTarGz(archivePath: string, destDir: string): Promise<void> {
    const wantedBinary = this.getBinaryName().replace(/\\/g, "/");
    const wantedBinaryLower = wantedBinary.toLowerCase();
    const allowedPrefixes = this.getAllowedArchivePrefixes();
    const allowedRoots = new Set(allowedPrefixes.map((p) => p.split("/")[0]).filter((p) => p.length > 0));

    const rawEntries: string[] = [];
    await tar.t({
      file: archivePath,
      onentry: (e) => {
        const p = String((e as any)?.path || "");
        if (p) rawEntries.push(p);
      },
    });

    const firstParts: string[] = [];
    for (const raw of rawEntries) {
      const rel = this.toSafePosixRel(raw);
      if (!rel) continue;
      const parts = rel.split("/");
      const first = parts[0] || "";
      if (!first) continue;
      const lower = rel.toLowerCase();
      if (lower === wantedBinaryLower) continue;
      if (allowedRoots.has(first)) continue;
      firstParts.push(first);
    }

    const uniqueFirst = Array.from(new Set(firstParts));
    const strip = uniqueFirst.length === 1 ? 1 : 0;

    await tar.x({
      file: archivePath,
      cwd: destDir,
      strip,
      filter: (p) => {
        const safeRel = this.toSafePosixRel(String(p || ""));
        if (!safeRel) return false;
        const lower = safeRel.toLowerCase();
        if (lower === wantedBinaryLower || lower.endsWith(`/${wantedBinaryLower}`)) return true;

        const parts = safeRel.split("/");
        const strippedRel = strip > 0 ? parts.slice(strip).join("/") : safeRel;
        if (!strippedRel) return false;
        const strippedLower = strippedRel.toLowerCase();
        return allowedPrefixes.some((prefix) => strippedLower.startsWith(prefix));
      },
    });

    const binaryPath = path.join(destDir, this.getBinaryName());
    if (!(await this.isFile(binaryPath))) throw new Error("docwen_tar_missing_binary");
    if (!(await this.existsDir(path.join(destDir, "_internal")))) throw new Error("docwen_tar_missing_internal");
    if (!(await this.existsDir(path.join(destDir, "templates")))) throw new Error("docwen_tar_missing_templates");
    if (!(await this.existsDir(path.join(destDir, "configs")))) throw new Error("docwen_tar_missing_configs");
    if (!(await this.existsDir(path.join(destDir, "docwen", "i18n", "locales")))) {
      throw new Error("docwen_tar_missing_locales");
    }
  }

  private pickResourceRel(rawName: string): string | null {
    const name = String(rawName || "").trim().replace(/\\/g, "/").replace(/^(\.\/)+/, "");
    if (!name) return null;
    const lower = name.toLowerCase();

    const templatesIdx = lower.indexOf("/templates/");
    if (lower.startsWith("templates/")) return name;
    if (templatesIdx >= 0) return name.slice(templatesIdx + 1);

    const configsIdx = lower.indexOf("/configs/");
    if (lower.startsWith("configs/")) return name;
    if (configsIdx >= 0) return name.slice(configsIdx + 1);

    const localesPrefix = "docwen/i18n/locales/";
    const localesIdx = lower.indexOf(`/${localesPrefix}`);
    if (lower.startsWith(localesPrefix)) return name;
    if (localesIdx >= 0) return name.slice(localesIdx + 1);

    return null;
  }

  private toSafePosixRel(p: string): string | null {
    const raw = String(p || "").trim().replace(/\\/g, "/");
    if (!raw) return null;
    const stripped = raw.replace(/^\/+/, "");
    if (path.posix.isAbsolute(stripped)) return null;
    const norm = path.posix.normalize(stripped);
    if (norm === "." || norm === "..") return null;
    if (norm.startsWith("../") || norm.includes("/../")) return null;
    return norm;
  }

  private async existsDir(p: string): Promise<boolean> {
    try {
      return (await fsp.stat(p)).isDirectory();
    } catch {
      return false;
    }
  }

  private async safeRm(p: string): Promise<void> {
    try {
      await fsp.rm(p, { recursive: true, force: true });
    } catch {}
  }

  private async downloadToFile(url: string, outPath: string, timeoutMs: number): Promise<void> {
    await this.downloadToFileWithLimits(url, outPath, {
      redirectsLeft: DocWenBinaryManager.MAX_REDIRECTS,
      timeoutMs,
    });
  }

  private async downloadToFileWithLimits(
    url: string,
    outPath: string,
    opts: { redirectsLeft: number; timeoutMs: number },
  ): Promise<void> {
    if (opts.redirectsLeft < 0) throw new Error("download_redirects_exceeded");

    await new Promise<void>((resolve, reject) => {
      const req = https.get(url, (res) => {
        const status = res.statusCode || 0;

        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          let next: string;
          try {
            next = new URL(res.headers.location, url).toString();
          } catch {
            reject(new Error("download_redirect_invalid_location"));
            return;
          }
          this.downloadToFileWithLimits(next, outPath, {
            redirectsLeft: opts.redirectsLeft - 1,
            timeoutMs: opts.timeoutMs,
          }).then(resolve, reject);
          return;
        }

        if (status !== 200) {
          res.resume();
          reject(new Error(`download_failed_${status || "unknown"}`));
          return;
        }

        const file = fs.createWriteStream(outPath);
        const fail = (e: any) => {
          try {
            file.close(() => {});
          } catch {}
          this.safeRm(outPath).then(
            () => reject(e),
            () => reject(e),
          );
        };

        res.on("error", fail);
        file.on("error", fail);
        file.on("finish", () => file.close(() => resolve()));
        res.pipe(file);
      });

      req.setTimeout(opts.timeoutMs, () => req.destroy(new Error("download_timeout")));
      req.on("error", (e) => reject(e));
    });
  }

  private parseSha256Sums(text: string): Map<string, string> {
    const map = new Map<string, string>();
    for (const line of String(text || "").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const m = trimmed.match(/^([a-fA-F0-9]{64})\s+[*]?(.+)$/);
      if (!m) continue;
      const hash = m[1];
      const file = m[2].trim();
      map.set(file, hash);
    }
    return map;
  }

  private async sha256FileHex(p: string): Promise<string> {
    const hash = crypto.createHash("sha256");
    await new Promise<void>((resolve, reject) => {
      const stream = fs.createReadStream(p);
      stream.on("data", (d) => hash.update(d));
      stream.on("error", (e) => reject(e));
      stream.on("end", () => resolve());
    });
    return hash.digest("hex");
  }
}
