import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { recordCandidate } from "../release-candidate.mjs";
import { RELEASE_TARBALL_FILENAME } from "../release-package-lib.mjs";
import { makeTarball } from "./release-fixtures.mjs";

export const SOURCE = Object.freeze({
  repository: "owner/plugin",
  commit: "a".repeat(40),
  tree: "b".repeat(40),
  ref: "refs/heads/candidate",
  run_id: 71,
  run_attempt: 2,
});

export function makeCandidate(directory, tarOptions) {
  mkdirSync(directory);
  const tarball = makeTarball(tarOptions);
  const sha = createHash("sha256").update(tarball).digest("hex");
  writeFileSync(join(directory, RELEASE_TARBALL_FILENAME), tarball);
  writeFileSync(join(directory, "SHA256SUMS"), `${sha}  ${RELEASE_TARBALL_FILENAME}\n`);
  return recordCandidate(directory, { ...SOURCE });
}

export function corePin() {
  const asset = (id, name, character) => ({
    id,
    name,
    bytes: id * 10,
    sha256: character.repeat(64),
    apiUrl: `https://api.github.com/repos/ZHYX91/docwen/releases/assets/${id}`,
  });
  return {
    schema: "docwen.openclaw.core_release.v2",
    repository: "ZHYX91/docwen",
    tag: "0.12.0",
    version: "0.12.0",
    immutable: true,
    assets: {
      linux: asset(101, "DocWenCLI-0.12.0-linux-x64.tar.gz", "c"),
      windows: asset(102, "DocWen-windows-x64.zip", "d"),
    },
  };
}
