import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = process.argv[2];
if (process.platform !== "win32" || process.arch !== "x64")
  throw new Error("Windows x64 build host required.");
if (!output || !isAbsolute(output) || !existsSync(output))
  throw new Error("An existing owned output directory is required.");
const binary = join(output, "windows-x64.exe");
const object = join(output, "windows-job.obj");
if (existsSync(binary) || existsSync(object)) throw new Error("Native output already exists.");
const source = join(repository, "native/windows-job.c");
const definitions = join(repository, "native/windows-job.def");
function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: output,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    timeout: 60_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stdout}\n${result.stderr}`);
}
const compilerFlags = ["/nologo", "/std:c11", "/O1", "/GS-", "/Zl", "/W4", "/WX", "/c"];
run("cl.exe", [...compilerFlags, source, `/Fo${object}`]);
const linkerFlags = [
  "/nologo",
  "/entry:entry",
  "/subsystem:console",
  "/nodefaultlib",
  "/machine:x64",
  "/Brepro",
];
run("link.exe", [...linkerFlags, object, "kernel32.lib", `/out:${binary}`]);
// MSVC /Brepro uses a content-derived COFF timestamp. Normalize that field to
// zero explicitly; there is no signature or debug path in this no-CRT binary.
const bytes = readFileSync(binary);
const pe = bytes.readUInt32LE(0x3c);
if (bytes.readUInt32LE(pe) !== 0x4550 || bytes.readUInt16LE(pe + 4) !== 0x8664)
  throw new Error("Unexpected PE identity.");
bytes.writeUInt32LE(0, pe + 8);
writeFileSync(binary, bytes);
const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const compiler = spawnSync("cl.exe", [], { encoding: "utf8", windowsHide: true, shell: false }).stderr.split(
  /\r?\n/u,
)[0];
const linker = spawnSync("link.exe", [], { encoding: "utf8", windowsHide: true, shell: false }).stdout.split(
  /\r?\n/u,
)[0];
writeFileSync(
  join(output, "build.json"),
  `${JSON.stringify(
    {
      sourceSha256: sha256(source),
      defSha256: sha256(definitions),
      binarySha256: sha256(binary),
      binaryBytes: bytes.length,
      platform: "win32",
      arch: "x64",
      minimumWindows: "10",
      compiler,
      linker,
      compilerFlags,
      linkerFlags,
      timestamp: 0,
      timestampNormalization: "COFF TimeDateStamp zeroed after deterministic MSVC link",
    },
    null,
    2,
  )}\n`,
  { flag: "wx" },
);
