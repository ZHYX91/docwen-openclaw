import { describe, expect, it } from "vitest";

import { selectPinnedRelease, validatePinnedRecord } from "./fetch-docwen-release.mjs";

const digest = (character) => `sha256:${character.repeat(64)}`;

function asset(id, name, character) {
  return {
    id,
    name,
    state: "uploaded",
    size: id * 10,
    digest: digest(character),
    url: `https://api.github.com/repos/ZHYX91/docwen/releases/assets/${id}`,
  };
}

function release(version, options = {}) {
  return {
    tag_name: version,
    draft: false,
    prerelease: false,
    published_at: "2026-09-15T00:00:00Z",
    immutable: options.immutable ?? true,
    assets: options.assets ?? [
      asset(101, `DocWenCLI-${version}-linux-x64.tar.gz`, "a"),
      asset(102, "DocWen-windows-x64.zip", "b"),
    ],
  };
}

describe("pinned DocWen release selection", () => {
  it("resolves the latest supported immutable release containing both platform identities", () => {
    const record = selectPinnedRelease([
      release("0.10.9"),
      release("0.11.0"),
      release("0.12.5", {
        assets: [
          asset(501, "DocWenCLI-0.12.5-linux-x64.tar.gz", "c"),
          asset(502, "DocWen-windows-x64.zip", "d"),
        ],
      }),
      release("0.13.0", { immutable: false }),
    ]);

    expect(record).toEqual({
      schema: "docwen.openclaw.core_release.v2",
      repository: "ZHYX91/docwen",
      tag: "0.12.5",
      version: "0.12.5",
      immutable: true,
      assets: {
        linux: {
          id: 501,
          name: "DocWenCLI-0.12.5-linux-x64.tar.gz",
          bytes: 5010,
          sha256: "c".repeat(64),
          apiUrl: "https://api.github.com/repos/ZHYX91/docwen/releases/assets/501",
        },
        windows: {
          id: 502,
          name: "DocWen-windows-x64.zip",
          bytes: 5020,
          sha256: "d".repeat(64),
          apiUrl: "https://api.github.com/repos/ZHYX91/docwen/releases/assets/502",
        },
      },
    });
  });

  it("fails closed when the newest supported immutable release lacks either pinned package", () => {
    expect(() =>
      selectPinnedRelease([
        release("0.11.0"),
        release("0.12.5", {
          assets: [asset(501, "DocWenCLI-0.12.5-linux-x64.tar.gz", "c")],
        }),
      ]),
    ).toThrow("docwen_release_asset_identity_invalid:windows");
  });

  it("rejects an ambiguous latest release instead of choosing by API order", () => {
    expect(() => selectPinnedRelease([release("0.12.5"), release("0.12.5")])).toThrow(
      "latest_docwen_release_ambiguous",
    );
  });

  it("ignores releases below the supported packaged baseline", () => {
    expect(() => selectPinnedRelease([release("0.9.9"), release("0.10.99"), release("0.11.99")])).toThrow(
      "no_immutable_supported_docwen_release",
    );
  });

  it("rejects extra fields and asset URLs outside the exact DocWen API identity", () => {
    const record = selectPinnedRelease([release("0.12.0")]);
    expect(() => validatePinnedRecord({ ...record, legacy: true })).toThrow("docwen_pin_keys_invalid");
    const tampered = JSON.parse(JSON.stringify(record));
    tampered.assets.windows.apiUrl = "https://example.invalid/archive.zip";
    expect(() => validatePinnedRecord(tampered)).toThrow("docwen_pin_asset_invalid:windows");
  });
});
