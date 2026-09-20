import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CANDIDATE_FILE,
  artifactAttempt,
  assembleCandidate,
  assertSourceAccepted,
  loadCandidate,
  recordCandidate,
  validateArtifactTransport,
  validateCandidateRecord,
} from "./release-candidate.mjs";
import { PACKAGE_VERSION, RELEASE_TARBALL_FILENAME } from "./release-package-lib.mjs";
import { loadPublication } from "./publish-release.mjs";
import { SOURCE, corePin, makeCandidate } from "./testing/candidate-fixtures.mjs";

const roots = [];
function root() {
  const directory = mkdtempSync(join(tmpdir(), "oc-candidate-"));
  roots.push(directory);
  return directory;
}
afterEach(() => {
  for (const directory of roots.splice(0)) rmSync(directory, { recursive: true });
});
const canonical = (value) => `${JSON.stringify(value)}\n`;

describe("one candidate from build through publication", () => {
  it("adds the Core pin without changing the original archive or source record, including recovery", () => {
    const directory = root();
    const built = join(directory, "build");
    const original = makeCandidate(built);
    const pinFile = join(directory, "pin.json");
    writeFileSync(pinFile, canonical(corePin()));
    const publication = join(directory, "publication");
    const assembled = assembleCandidate(built, publication, pinFile);
    expect([...assembled.files.keys()].sort()).toEqual(
      [CANDIDATE_FILE, "DOCWEN-CORE.json", "SHA256SUMS", RELEASE_TARBALL_FILENAME].sort(),
    );
    for (const name of [CANDIDATE_FILE, RELEASE_TARBALL_FILENAME]) {
      expect(assembled.files.get(name)).toEqual(original.files.get(name));
    }
    expect(assembled.record.source).toEqual(SOURCE);
    expect(loadPublication(publication, PACKAGE_VERSION)).toEqual(assembled.files);
    expect(() => loadPublication(publication, "999.0.0")).toThrow("publication_version_invalid");
    const resumed = assembleCandidate(publication, join(directory, "resumed"), pinFile);
    expect(resumed.files).toEqual(assembled.files);
    const changedPin = corePin();
    changedPin.assets.windows.sha256 = "f".repeat(64);
    writeFileSync(pinFile, canonical(changedPin));
    expect(() => assembleCandidate(publication, join(directory, "changed"), pinFile)).toThrow(
      "candidate_core_pin_changed",
    );
    expect(existsSync(join(directory, "changed"))).toBe(false);
    expect(loadCandidate(built).files).toEqual(original.files);
  });

  it("requires the publication pin, refuses extra files and never resets an existing destination", () => {
    const directory = root();
    const built = join(directory, "build");
    const original = makeCandidate(built);
    expect(() => loadCandidate(built, true)).toThrow("candidate_core_pin_missing");
    const pinFile = join(directory, "pin.json");
    writeFileSync(pinFile, canonical(corePin()));
    expect(() => assembleCandidate(built, built, pinFile)).toThrow();
    expect(loadCandidate(built).files).toEqual(original.files);
    expect(() => recordCandidate(built, SOURCE)).toThrow("candidate_build_file_set_invalid");
    writeFileSync(join(built, "unexpected"), "extra");
    expect(() => loadCandidate(built)).toThrow("candidate_file_set_invalid");
  });

  it("rejects source-record edits unless their checksums agree, and rejects noncanonical records", () => {
    const directory = join(root(), "build");
    const original = makeCandidate(directory);
    const record = JSON.parse(original.files.get(CANDIDATE_FILE));
    record.source.commit = "f".repeat(40);
    writeFileSync(join(directory, CANDIDATE_FILE), canonical(record));
    expect(() => loadCandidate(directory)).toThrow("candidate_checksum_mismatch");
    writeFileSync(join(directory, CANDIDATE_FILE), JSON.stringify(record, null, 2));
    expect(() => loadCandidate(directory)).toThrow("candidate_record_not_canonical");
  });

  it("verifies the actual tar bytes against both the candidate identity and checksum manifest", () => {
    const directory = join(root(), "build");
    const original = makeCandidate(directory);
    const tarball = original.files.get(RELEASE_TARBALL_FILENAME);
    const changed = JSON.parse(original.files.get(CANDIDATE_FILE));
    changed.package.sha256 = "f".repeat(64);
    expect(() => validateCandidateRecord(changed, tarball)).toThrow("candidate_identity_mismatch");
    expect(() => validateCandidateRecord({ ...original.record, unexpected: true }, tarball)).toThrow(
      "candidate_record_keys_invalid",
    );
    writeFileSync(join(directory, "SHA256SUMS"), "f".repeat(64));
    expect(() => loadCandidate(directory)).toThrow("candidate_checksum_mismatch");
    expect(
      createHash("sha256")
        .update(readFileSync(join(directory, RELEASE_TARBALL_FILENAME)))
        .digest("hex"),
    ).toBe(original.record.package.sha256);
    expect(Buffer.isBuffer(tarball)).toBe(true);
  });
});

function transport(kind = "publication") {
  const artifact = {
    id: 91,
    name: `openclaw-docwen-${kind}-71-2`,
    expired: false,
    digest: `sha256:${"e".repeat(64)}`,
    workflow_run: { id: 71, repository_id: 17, head_repository_id: 17, head_sha: SOURCE.commit },
  };
  const run = {
    id: 71,
    run_attempt: 2,
    repository: { id: 17 },
    head_repository: { id: 17 },
    head_sha: SOURCE.commit,
    path: ".github/workflows/release.yml",
    event: "workflow_dispatch",
    status: "completed",
    conclusion: "success",
  };
  const job = {
    name: kind === "publication" ? "verify-release" : "Prepare or reuse the exact plugin candidate",
    run_id: 71,
    head_sha: SOURCE.commit,
    status: "completed",
    conclusion: "success",
  };
  const options = {
    id: 91,
    digest: artifact.digest,
    repositoryId: 17,
    jobs: { total_count: 1, jobs: [job] },
    publish: true,
  };
  return { artifact, run, options, job };
}

describe("retained artifact transport", () => {
  it("accepts a verified publication from its exact attempt even if a later publish job failed", () => {
    const { artifact, run, options } = transport();
    expect(validateArtifactTransport(artifact, run, options)).toEqual({
      kind: "publication",
      runId: 71,
      attempt: 2,
    });
    run.conclusion = "failure";
    expect(validateArtifactTransport(artifact, run, options).attempt).toBe(2);
  });

  it.each([
    (h) => {
      h.artifact.expired = true;
    },
    (h) => {
      h.artifact.digest = `sha256:${"f".repeat(64)}`;
    },
    (h) => {
      h.artifact.workflow_run.head_repository_id = 18;
    },
    (h) => {
      h.run.head_repository.id = 18;
    },
    (h) => {
      h.run.event = "pull_request";
    },
    (h) => {
      h.run.path = ".github/workflows/ci.yml";
    },
    (h) => {
      h.run.run_attempt = 3;
    },
    (h) => {
      h.run.status = "in_progress";
    },
    (h) => {
      h.job.conclusion = "failure";
    },
    (h) => {
      h.job.conclusion = "skipped";
    },
    (h) => {
      h.job.conclusion = "cancelled";
    },
    (h) => {
      h.job.head_sha = "f".repeat(40);
    },
    (h) => {
      h.options.jobs.jobs = [];
      h.options.jobs.total_count = 0;
    },
    (h) => {
      h.options.jobs.total_count = 101;
    },
  ])("rejects wrong bytes, repository, source, attempt or producer evidence (%#)", (change) => {
    const h = transport();
    change(h);
    expect(() => validateArtifactTransport(h.artifact, h.run, h.options)).toThrow(
      "candidate_artifact_transport_rejected",
    );
  });

  it("permits a build for later verification but never treats it as a publishable artifact", () => {
    const { artifact, run, options } = transport("build");
    expect(() => validateArtifactTransport(artifact, run, options)).toThrow(
      "candidate_artifact_transport_rejected",
    );
    options.publish = false;
    expect(validateArtifactTransport(artifact, run, options).kind).toBe("build");
    artifact.name = "openclaw-docwen-publication-72-2";
    expect(() => artifactAttempt(artifact)).toThrow("candidate_artifact_name_invalid");
  });
});

describe("default branch acceptance of the actual candidate source", () => {
  function sourceApi(head, tree, comparison) {
    return {
      read: vi.fn(async (endpoint) => {
        if (endpoint === `git/commits/${SOURCE.commit}`)
          return { sha: SOURCE.commit, tree: { sha: SOURCE.tree } };
        if (endpoint === "git/ref/heads/main") return { object: { type: "commit", sha: head } };
        if (endpoint === `git/commits/${head}`) return { sha: head, tree: { sha: tree } };
        if (endpoint === `compare/${SOURCE.commit}...${head}`) return comparison;
        throw new Error(`unexpected endpoint:${endpoint}`);
      }),
    };
  }
  it("accepts the same commit, a squash with an identical full tree, or a contained ancestor", async () => {
    await expect(assertSourceAccepted(sourceApi(SOURCE.commit), SOURCE, "main")).resolves.toBe("same_commit");
    const head = "c".repeat(40);
    await expect(assertSourceAccepted(sourceApi(head, SOURCE.tree), SOURCE, "main", head)).resolves.toBe(
      "same_tree",
    );
    await expect(
      assertSourceAccepted(
        sourceApi(head, "d".repeat(40), { status: "ahead", merge_base_commit: { sha: SOURCE.commit } }),
        SOURCE,
        "main",
        head,
      ),
    ).resolves.toBe("ancestor");
  });
  it("rejects unaccepted source, source-tree mismatch and a stale publication checkout", async () => {
    const head = "c".repeat(40);
    const api = sourceApi(head, "d".repeat(40), {
      status: "diverged",
      merge_base_commit: { sha: "e".repeat(40) },
    });
    await expect(assertSourceAccepted(api, SOURCE, "main")).rejects.toThrow("candidate_source_not_accepted");
    await expect(assertSourceAccepted(api, { ...SOURCE, tree: "f".repeat(40) }, "main")).rejects.toThrow(
      "candidate_source_tree_mismatch",
    );
    await expect(assertSourceAccepted(api, SOURCE, "main", SOURCE.commit)).rejects.toThrow(
      "candidate_default_branch_mismatch",
    );
  });
});
