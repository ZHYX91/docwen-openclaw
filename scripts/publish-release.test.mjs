import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import { ensureTag, inspectRelease, publishRelease, verifyTag } from "./publish-release.mjs";
import { githubApi } from "./release-github.mjs";

const version = "3.0.0";
const { Response, structuredClone } = globalThis;
const commit = "a".repeat(40);
const files = new Map([
  ["plugin.tgz", Buffer.from("accepted package")],
  ["SHA256SUMS", Buffer.from("accepted checksums")],
]);
function asset(name, bytes, id = 1) {
  return {
    id,
    name,
    state: "uploaded",
    size: bytes.length,
    digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  };
}
function harness(options = {}) {
  let release = options.release ?? null;
  const writes = [];
  const uploads = [];
  const api = {
    read: vi.fn(async (endpoint) => {
      if (endpoint === `git/ref/tags/${version}`)
        return { object: { type: "commit", sha: options.tagCommit ?? commit } };
      return structuredClone(release);
    }),
    write: vi.fn(async (method, endpoint, body) => {
      writes.push({ method, endpoint, body });
      if (method === "POST") {
        release = { id: 17, tag_name: version, draft: true, prerelease: false, assets: [] };
      } else {
        release.draft = false;
        release.immutable = !options.mutable;
        release.published_at = "2026-09-20T01:00:00Z";
      }
      if (options.lostResponses) throw new Error("connection lost after write");
      return structuredClone(release);
    }),
    upload: vi.fn(async (id, name, bytes) => {
      uploads.push(name);
      if (options.failUpload === name) throw new Error("upload did not complete");
      release.assets.push(asset(name, bytes, release.assets.length + 1));
      if (options.lostResponses) throw new Error("upload response lost");
    }),
  };
  return {
    api,
    writes,
    uploads,
    get release() {
      return release;
    },
  };
}
const draft = (assets = []) => ({ id: 17, tag_name: version, draft: true, prerelease: false, assets });

describe("recoverable release publication", () => {
  it("creates a draft, uploads each accepted byte sequence once and then publishes", async () => {
    const h = harness();
    await expect(publishRelease(h.api, { version, commit, files }, async () => {})).resolves.toMatchObject({
      decision: "published",
      releaseId: 17,
      missing: [],
    });
    expect(h.writes.map(({ method }) => method)).toEqual(["POST", "PATCH"]);
    expect(h.writes[0].body.draft).toBe(true);
    expect(h.uploads).toEqual([...files.keys()]);
    expect(h.api.upload.mock.calls[0][2]).toEqual(files.get("plugin.tgz"));
  });

  it("resumes a partial draft without uploading its matching asset again", async () => {
    const h = harness({ release: draft([asset("plugin.tgz", files.get("plugin.tgz"))]) });
    await publishRelease(h.api, { version, commit, files });
    expect(h.uploads).toEqual(["SHA256SUMS"]);
    expect(h.writes.map(({ method }) => method)).toEqual(["PATCH"]);
  });

  it("recovers lost create, upload and finalize responses through readback without duplicate writes", async () => {
    const h = harness({ lostResponses: true });
    await publishRelease(h.api, { version, commit, files });
    expect(h.writes.map(({ method }) => method)).toEqual(["POST", "PATCH"]);
    expect(h.uploads).toEqual([...files.keys()]);
  });

  it("leaves an interrupted partial upload as a draft for a later invocation", async () => {
    const h = harness({ failUpload: "SHA256SUMS" });
    await expect(publishRelease(h.api, { version, commit, files })).rejects.toThrow(
      "upload did not complete",
    );
    expect(h.release.draft).toBe(true);
    expect(h.release.assets.map(({ name }) => name)).toEqual(["plugin.tgz"]);
    expect(h.writes.map(({ method }) => method)).toEqual(["POST"]);
    const resumed = harness({ release: h.release });
    await publishRelease(resumed.api, { version, commit, files });
    expect(resumed.uploads).toEqual(["SHA256SUMS"]);
  });

  it.each([
    [asset("plugin.tgz", Buffer.from("different accepted bytes"))],
    [asset("unexpected", Buffer.from("extra"))],
    [asset("plugin.tgz", files.get("plugin.tgz")), asset("plugin.tgz", files.get("plugin.tgz"), 2)],
    [{ ...asset("plugin.tgz", files.get("plugin.tgz")), state: "starter" }],
  ])("does not overwrite or delete conflicting existing assets", async (...assets) => {
    const h = harness({ release: draft(assets) });
    await expect(publishRelease(h.api, { version, commit, files })).rejects.toThrow(
      "publication_existing_asset_conflict",
    );
    expect(h.writes).toEqual([]);
    expect(h.uploads).toEqual([]);
  });

  it("performs a read-only no-op for a complete immutable release", async () => {
    const h = harness({
      release: {
        ...draft([...files].map(([name, bytes], index) => asset(name, bytes, index + 1))),
        draft: false,
        immutable: true,
        published_at: "now",
      },
    });
    expect((await publishRelease(h.api, { version, commit, files })).decision).toBe("noop");
    expect(h.writes).toEqual([]);
    expect(h.uploads).toEqual([]);
  });

  it("rejects an unexpected tag and public mutable release before writes", async () => {
    const h = harness({ tagCommit: "b".repeat(40) });
    await expect(publishRelease(h.api, { version, commit, files })).rejects.toThrow(
      "publication_tag_mismatch",
    );
    expect(h.writes).toEqual([]);
    expect(() => inspectRelease({ ...draft(), draft: false }, version, files)).toThrow(
      "publication_public_release_not_immutable",
    );
  });

  it("does not call a mutable final release complete or retry its PATCH", async () => {
    const h = harness({ mutable: true });
    const wait = vi.fn(async () => {});
    await expect(publishRelease(h.api, { version, commit, files }, wait)).rejects.toThrow(
      "publication_finalization_unconfirmed",
    );
    expect(wait).toHaveBeenCalledTimes(4);
    expect(h.writes.filter(({ method }) => method === "PATCH")).toHaveLength(1);
  });

  it("peels an annotated tag and rejects an unresolved cycle", async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce({ object: { type: "tag", sha: "b".repeat(40) } })
      .mockResolvedValue({ object: { type: "commit", sha: commit } });
    await verifyTag({ read }, version, commit);
    expect(read.mock.calls[1][0]).toBe(`git/tags/${"b".repeat(40)}`);
    read.mockResolvedValue({ object: { type: "tag", sha: "b".repeat(40) } });
    await expect(verifyTag({ read }, version, commit)).rejects.toThrow("publication_tag_mismatch");
  });
});

describe("tag creation for an accepted candidate", () => {
  it("creates the numeric tag at the original source once and reads back a lost response", async () => {
    let tag = null;
    const api = {
      read: vi.fn(async () => tag),
      write: vi.fn(async (_method, _endpoint, body) => {
        tag = { object: { type: "commit", sha: body.sha } };
        throw new Error("response lost after tag creation");
      }),
    };
    await ensureTag(api, version, commit, true);
    expect(api.write).toHaveBeenCalledExactlyOnceWith("POST", "git/refs", {
      ref: `refs/tags/${version}`,
      sha: commit,
    });
    await ensureTag(api, version, commit, true);
    expect(api.write).toHaveBeenCalledTimes(1);
  });

  it("never retargets an existing tag or creates one without manual publication context", async () => {
    const api = {
      read: vi.fn(async () => ({ object: { type: "commit", sha: "b".repeat(40) } })),
      write: vi.fn(),
    };
    await expect(ensureTag(api, version, commit, true)).rejects.toThrow("publication_tag_mismatch");
    api.read.mockResolvedValue(null);
    await expect(ensureTag(api, version, commit)).rejects.toThrow("publication_tag_mismatch");
    expect(api.write).not.toHaveBeenCalled();
  });

  it("preserves an unconfirmed creation error without attempting a second write", async () => {
    const api = {
      read: vi.fn(async () => null),
      write: vi.fn(async () => {
        throw new Error("offline");
      }),
    };
    await expect(ensureTag(api, version, commit, true)).rejects.toThrow("offline");
    expect(api.write).toHaveBeenCalledTimes(1);
  });
});

describe("GitHub request boundaries", () => {
  it("retries transient reads, keeps writes single-attempt and uploads exact bytes", async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }))
      .mockResolvedValueOnce(new Response("error", { status: 502 }))
      .mockResolvedValueOnce(new Response("{}", { status: 201 }));
    const wait = vi.fn(async () => {});
    const api = githubApi("owner/repo", "fake-token", fetch, wait);
    await api.read("releases");
    await expect(api.write("POST", "releases", {})).rejects.toThrow("publication_github_http_502");
    await api.upload(17, "plugin.tgz", files.get("plugin.tgz"));
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(wait).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[3][0]).toBe(
      "https://uploads.github.com/repos/owner/repo/releases/17/assets?name=plugin.tgz",
    );
    expect(fetch.mock.calls[3][1].body).toBe(files.get("plugin.tgz"));
    expect(fetch.mock.calls[3][1].redirect).toBe("error");
  });

  it("distinguishes missing state from authorization failure and bounds repeated failures", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("missing", { status: 404 }))
      .mockResolvedValueOnce(new Response("denied", { status: 403 }))
      .mockResolvedValue(new Response("busy", { status: 503 }));
    const api = githubApi("owner/repo", "fake-token", fetch, async () => {});
    expect(await api.read("releases/tags/3.0.0")).toBeNull();
    await expect(api.read("releases")).rejects.toThrow("publication_github_http_403");
    await expect(api.read("releases")).rejects.toThrow("publication_github_http_503");
    expect(fetch).toHaveBeenCalledTimes(5);
  });
});
