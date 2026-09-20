import { spawnSync } from "node:child_process";
import { copyFileSync, constants, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = process.argv[2];
if (process.platform !== "linux" || process.arch !== "x64") throw new Error("Linux x64 build host required.");
if (!output || !isAbsolute(output) || !existsSync(output))
  throw new Error("An existing owned output directory is required.");
const binary = join(output, "linux-x64.node");
if (existsSync(binary)) throw new Error("Native output already exists.");
const source = join(repository, "native", "rename-directory.c");
const compiler = process.env.CC || "cc";
const headers = join(dirname(dirname(process.execPath)), "include", "node");
const args = [
  "-shared",
  "-fPIC",
  "-O2",
  "-Wall",
  "-Wextra",
  "-Werror",
  "-fno-ident",
  "-Wl,--build-id=none",
  "-DNAPI_VERSION=8",
  "-I",
  headers,
  source,
  "-o",
  binary,
];
const built = spawnSync(compiler, args, { stdio: "inherit", shell: false });
if (built.error) throw built.error;
if (built.status !== 0) throw new Error("Native directory publication build failed.");
const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
writeFileSync(
  join(output, "build.json"),
  `${JSON.stringify({ sourceSha256: sha256(source), binarySha256: sha256(binary), nodeApi: 8, platform: "linux", arch: "x64", compiler: spawnSync(compiler, ["--version"], { encoding: "utf8", shell: false }).stdout.trim(), args }, null, 2)}\n`,
  { flag: "wx" },
);
copyFileSync(source, join(output, "rename-directory.c"), constants.COPYFILE_EXCL);
