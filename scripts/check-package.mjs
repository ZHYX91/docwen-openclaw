import console from "node:console";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

import { RELEASE_FILES, assertReleaseToolchain, packAndVerify } from "./release-package-lib.mjs";
import { createReleaseWork, finishReleaseWork } from "./release-work.mjs";

const npmCli = process.env.npm_execpath;
assertReleaseToolchain(npmCli);
const work = createReleaseWork(process.cwd());
const temporaryRoot = work.root;
let success = false;
try {
  mkdirSync(join(temporaryRoot, "tmp"));
  mkdirSync(join(temporaryRoot, "npm-cache"));
  const result = packAndVerify(process.cwd(), join(temporaryRoot, "pack"), npmCli, {
    ...process.env,
    TEMP: join(temporaryRoot, "tmp"),
    TMP: join(temporaryRoot, "tmp"),
    TMPDIR: join(temporaryRoot, "tmp"),
    npm_config_cache: join(temporaryRoot, "npm-cache"),
  });
  console.log(`Actual npm package verified: ${RELEASE_FILES.length} files, SHA-256 ${result.sha256}.`);
  success = true;
} finally {
  finishReleaseWork(work, success);
}
