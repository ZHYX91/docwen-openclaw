import { Buffer } from "node:buffer";
import { gzipSync } from "node:zlib";
import { PACKAGE_VERSION, RELEASE_FILES } from "../release-package-lib.mjs";

const BLOCK_SIZE = 512;
const PORTABLE_MTIME_SECONDS = 499_162_500;

function writeOctal(header, offset, length, value) {
  const encoded = value.toString(8).padStart(length - 1, "0");
  header.write(encoded, offset, length - 1, "ascii");
  header[offset + length - 1] = 0;
}

function packageJson(overrides = {}) {
  return JSON.stringify({
    name: "@zhyx91/openclaw-docwen",
    version: PACKAGE_VERSION,
    type: "module",
    license: "MIT",
    main: "dist/index.js",
    types: "dist/index.d.ts",
    files: [
      "dist",
      "native/linux-x64.node",
      "openclaw.plugin.json",
      "openclaw-config.example.json5",
      "skills",
      "README.md",
      "LICENSE",
    ],
    openclaw: {
      extensions: ["./dist/index.js"],
      compat: {
        pluginApi: ">=2026.7.1-2 <2027.0.0",
        minGatewayVersion: "2026.7.1-2",
      },
      build: {
        openclawVersion: "2026.7.1-2",
        pluginSdkVersion: "2026.7.1-2",
      },
    },
    peerDependencies: { openclaw: ">=2026.7.1-2 <2027.0.0" },
    ...overrides,
  });
}

function entryContents(path, packageOverrides = {}) {
  if (path === "package.json") return Buffer.from(packageJson(packageOverrides));
  if (path === "openclaw.plugin.json") {
    return Buffer.from(JSON.stringify({ id: "docwen", name: "DocWen", version: PACKAGE_VERSION }));
  }
  return Buffer.from(`${path}\n`);
}

function tarHeader(path, contents, { mode = 0o644, type = "0" } = {}) {
  const header = Buffer.alloc(BLOCK_SIZE);
  const archivePath = `package/${path}`;
  if (Buffer.byteLength(archivePath) > 100) throw new Error("test_path_too_long");
  header.write(archivePath, 0, 100, "utf8");
  writeOctal(header, 100, 8, mode);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, contents.length);
  writeOctal(header, 136, 12, PORTABLE_MTIME_SECONDS);
  header.fill(0x20, 148, 156);
  header.write(type, 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "latin1");
  header.write("00", 263, 2, "ascii");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(checksum.toString(8).padStart(6, "0"), 148, 6, "ascii");
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

export function makeTarball({
  paths = RELEASE_FILES,
  replacePath,
  modeByPath = new Map(),
  typeByPath = new Map(),
  packageOverrides = {},
  contentsByPath = new Map(),
} = {}) {
  const blocks = [];
  for (const originalPath of paths) {
    const path = replacePath?.get(originalPath) ?? originalPath;
    const contents = contentsByPath.get(originalPath) ?? entryContents(originalPath, packageOverrides);
    blocks.push(
      tarHeader(path, contents, {
        mode: modeByPath.get(originalPath),
        type: typeByPath.get(originalPath),
      }),
    );
    blocks.push(contents);
    const padding = Math.ceil(contents.length / BLOCK_SIZE) * BLOCK_SIZE - contents.length;
    if (padding > 0) blocks.push(Buffer.alloc(padding));
  }
  blocks.push(Buffer.alloc(BLOCK_SIZE * 2));
  const compressed = gzipSync(Buffer.concat(blocks), { level: 9, mtime: 0 });
  compressed[9] = 0xff;
  return compressed;
}
