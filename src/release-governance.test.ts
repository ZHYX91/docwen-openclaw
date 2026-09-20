import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("release governance", () => {
  it("uses numeric product tags and versioned assets without a v prefix", () => {
    const workflow = readFileSync(".github/workflows/release.yml", "utf8");
    const ciWorkflow = readFileSync(".github/workflows/ci.yml", "utf8");
    const releaseLibrary = readFileSync("scripts/release-package-lib.mjs", "utf8");
    const readme = readFileSync("README.md", "utf8");

    expect(workflow).toContain('"[0-9]*.[0-9]*.[0-9]*"');
    expect(workflow).not.toContain('"v*"');
    expect(releaseLibrary).toContain("RELEASE_TARBALL_FILENAME = `openclaw-docwen-${PACKAGE_VERSION}.tgz`");
    expect(releaseLibrary).not.toContain("openclaw-docwen-v2.0.0");
    expect(readme).not.toContain("openclaw-docwen-v2.0.0");
    expect(ciWorkflow).toContain("workflow_dispatch:");
  });

  it("keeps candidate checks, recoverable draft publication and one independent public readback", () => {
    const workflow = readFileSync(".github/workflows/release.yml", "utf8");
    const publish = workflow.split("\n  publish:\n", 2)[1]?.split("\n  post-verify:\n", 1)[0];
    const postVerify = workflow.split("\n  post-verify:\n", 2)[1];
    expect(publish).toBeDefined();
    expect(postVerify).toBeDefined();
    expect(workflow).not.toContain("replica:");
    expect(workflow).toContain("npm run check:source");
    expect(workflow).toContain("artifact-ids: ${{ needs.build-release.outputs.artifact_id }}");
    expect(workflow).toContain("needs: [build-release, resolve-docwen, packaged-docwen]");
    expect(workflow).toContain("scripts/fetch-docwen-release.mjs resolve");
    expect(workflow).toContain("scripts/fetch-docwen-release.mjs fetch");
    expect(workflow).toContain('sha256sum -- "$binary"');
    expect(workflow).toContain("Get-FileHash -LiteralPath $binary.FullName -Algorithm SHA256");
    expect(workflow).not.toContain("$record.asset.sha256");
    expect(workflow).toContain("digest-mismatch: error");
    expect(publish).toContain("github.event_name == 'push'");
    expect(publish).toContain("inputs.mode == 'publish'");
    expect(workflow).toContain("inputs.mode != 'candidate' && inputs.mode != 'publish'");
    expect(workflow).toContain("if: inputs.candidate_artifact_id == ''");
    expect(workflow).toContain("scripts/release-candidate.mjs artifact");
    expect(workflow).toContain("DOCWEN_PLUGIN_CANDIDATE_DIR");
    expect(publish).toContain("scripts/publish-release.mjs inspect publication");
    expect(publish).toContain("steps.release_state.outputs.decision != 'noop'");
    expect(publish).toContain("scripts/publish-release.mjs publish publication");
    expect(publish).not.toContain("gh release download");
    expect(postVerify).toContain("gh release download");
    expect(postVerify).toContain("gh attestation verify");
    expect(postVerify).toContain("--source-digest");
    expect(workflow).not.toContain("--clobber");

    for (const line of workflow.split("\n")) {
      if (!line.includes("uses:")) continue;
      const action = line.split("uses:", 2)[1]?.split("#", 1)[0]?.trim();
      expect(action?.split("@", 2)[1]).toMatch(/^[0-9a-f]{40}$/u);
    }
  });

  it("accepts immutable numeric DocWen releases at the packaged compatibility baseline and above", () => {
    const source = readFileSync("scripts/fetch-docwen-release.mjs", "utf8");

    expect(source).toContain("release.immutable !== true");
    expect(source).toContain("MINIMUM_VERSION = Object.freeze([0, 12, 0])");
    expect(source).toContain("compareVersion(tuple, MINIMUM_VERSION) >= 0");
    expect(source).toContain('PIN_SCHEMA = "docwen.openclaw.core_release.v2"');
    expect(source).toContain('"DocWen-windows-x64.zip"');
    expect(source).toContain("DocWenCLI-${version}-linux-x64.tar.gz");
    expect(source).not.toMatch(/\^v\?/u);
  });
});
