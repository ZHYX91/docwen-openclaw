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
    expect(releaseLibrary).toContain('RELEASE_TARBALL_FILENAME = "openclaw-docwen-2.0.0.tgz"');
    expect(releaseLibrary).not.toContain("openclaw-docwen-v2.0.0");
    expect(readme).not.toContain("openclaw-docwen-v2.0.0");
    expect(ciWorkflow).toContain("workflow_dispatch:");
  });

  it("keeps preflight read-only and publishes only from an exact immutable boundary", () => {
    const workflow = readFileSync(".github/workflows/release.yml", "utf8");
    const publish = workflow.split("\n  publish:\n", 2)[1];
    expect(publish).toBeDefined();
    if (publish === undefined) throw new Error("publish job is missing");
    const releaseState = publish
      .split("      - name: Fail closed or select an exact immutable no-op\n", 2)[1]
      ?.split("      - name: Attest exact assets\n", 1)[0];
    expect(releaseState).toBeDefined();
    if (releaseState === undefined) throw new Error("release-state step is missing");

    expect(workflow).not.toContain("replica:");
    expect(workflow).toContain("npm run check:source");
    expect(workflow).toContain("artifact-ids: ${{ needs.build-release.outputs.artifact_id }}");
    expect(workflow).toContain("digest-mismatch: error");
    expect(workflow).toContain("needs: [build-release, resolve-docwen, packaged-docwen]");
    expect(workflow).toContain("scripts/fetch-docwen-release.mjs resolve");
    expect(workflow).toContain("scripts/fetch-docwen-release.mjs fetch");
    expect(workflow).toContain("DOCWEN-CORE.json");
    expect(workflow).toContain('sha256sum -- "$binary"');
    expect(workflow).toContain("stat -c '%s' -- \"$binary\"");
    expect(workflow).toContain("Get-FileHash -LiteralPath $binary.FullName -Algorithm SHA256");
    expect(workflow).toContain("[string]$binary.Length");
    expect(workflow).not.toContain("$record.asset.sha256");
    expect(workflow).not.toContain("$record.asset.bytes");
    expect(workflow).toContain("artifact-ids: ${{ needs.verify-release.outputs.artifact_id }}");
    expect(publish).toContain("if: github.event_name == 'push'");
    expect(publish).not.toContain("isImmutable");
    expect(publish).toContain(".immutable == true");
    expect(publish).toContain("/releases/tags/$RELEASE_VERSION");
    expect(publish).toContain('case "$release_status" in');
    expect(publish).toContain("404)");
    expect(publish).toContain("git ls-remote --exit-code");
    expect(publish).toContain("gh attestation verify");
    expect(publish).toContain("gh release create");
    expect(publish).not.toContain("actions/checkout@");
    expect(workflow).not.toContain("gh release upload");
    expect(workflow).not.toContain("--clobber");
    expect(releaseState).not.toContain('if gh release view "$RELEASE_VERSION"');
    expect(releaseState).toContain('((.published_at | type) == "string")');
    expect(releaseState).toContain("((.published_at | length) > 0)");

    for (const line of workflow.split("\n")) {
      if (!line.includes("uses:")) continue;
      const uses = line.split("uses:", 2)[1];
      expect(uses).toBeDefined();
      if (uses === undefined) throw new Error(`invalid uses line: ${line}`);
      const action = uses.split("#", 1)[0]?.trim();
      const ref = action?.split("@", 2)[1];
      expect(ref).toMatch(/^[0-9a-f]{40}$/u);
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
