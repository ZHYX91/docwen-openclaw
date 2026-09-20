import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { appendFileSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { githubApi } from "./release-github.mjs";
import { validatePinnedRecord } from "./fetch-docwen-release.mjs";
import { PACKAGE_VERSION, RELEASE_TARBALL_FILENAME, verifyTarballBuffer } from "./release-package-lib.mjs";

export const CANDIDATE_FILE = "CANDIDATE.json";
const SCHEMA = "docwen.openclaw.release_candidate.v1";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const canonical = (value) => `${JSON.stringify(value)}\n`;
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const commitId = (value) => typeof value === "string" && /^[0-9a-f]{40}$/u.test(value);
const sourceRef = (value) =>
  typeof value === "string" && /^refs\/(heads|tags)\/[^\r\n\0]{1,1000}$/u.test(value);
const repositoryName = (value) =>
  typeof value === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value);

function keys(value, expected) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())
  ) {
    throw new Error("candidate_record_keys_invalid");
  }
}

export function validateCandidateRecord(record, tarball) {
  keys(record, ["schema", "version", "source", "package"]);
  keys(record.source, ["repository", "commit", "tree", "ref", "run_id", "run_attempt"]);
  keys(record.package, ["name", "bytes", "sha256"]);
  if (
    record.schema !== SCHEMA ||
    record.version !== PACKAGE_VERSION ||
    !repositoryName(record.source.repository) ||
    !commitId(record.source.commit) ||
    !commitId(record.source.tree) ||
    !sourceRef(record.source.ref) ||
    !positive(record.source.run_id) ||
    !positive(record.source.run_attempt) ||
    record.package.name !== RELEASE_TARBALL_FILENAME ||
    record.package.bytes !== tarball.length ||
    record.package.sha256 !== sha256(tarball)
  )
    throw new Error("candidate_identity_mismatch");
  return record;
}

function checksum(files) {
  return [...files.keys()]
    .filter((name) => name !== "SHA256SUMS")
    .sort()
    .map((name) => `${sha256(files.get(name))}  ${name}\n`)
    .join("");
}

function readFiles(directory) {
  const root = lstatSync(directory);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("candidate_directory_invalid");
  return new Map(
    readdirSync(directory)
      .sort()
      .map((name) => {
        const file = join(directory, name);
        const stat = lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > 16 * 1024 * 1024) {
          throw new Error("candidate_file_invalid");
        }
        return [name, readFileSync(file)];
      }),
  );
}

export function loadCandidate(directory, requireCore = false) {
  const files = readFiles(directory);
  const expected = [CANDIDATE_FILE, "SHA256SUMS", RELEASE_TARBALL_FILENAME];
  if (files.has("DOCWEN-CORE.json")) expected.push("DOCWEN-CORE.json");
  else if (requireCore) throw new Error("candidate_core_pin_missing");
  if (JSON.stringify([...files.keys()]) !== JSON.stringify(expected.sort()))
    throw new Error("candidate_file_set_invalid");
  const tarball = files.get(RELEASE_TARBALL_FILENAME);
  verifyTarballBuffer(tarball);
  const raw = files.get(CANDIDATE_FILE).toString("utf8");
  const record = validateCandidateRecord(JSON.parse(raw), tarball);
  if (raw !== canonical(record)) throw new Error("candidate_record_not_canonical");
  if (files.has("DOCWEN-CORE.json")) {
    const pin = files.get("DOCWEN-CORE.json").toString("utf8");
    if (pin !== canonical(validatePinnedRecord(JSON.parse(pin))))
      throw new Error("candidate_core_pin_not_canonical");
  }
  if (files.get("SHA256SUMS").toString("utf8") !== checksum(files))
    throw new Error("candidate_checksum_mismatch");
  return { record, files };
}

export function recordCandidate(directory, source) {
  const files = readFiles(directory);
  if (
    JSON.stringify([...files.keys()].sort()) !==
    JSON.stringify(["SHA256SUMS", RELEASE_TARBALL_FILENAME].sort())
  ) {
    throw new Error("candidate_build_file_set_invalid");
  }
  const tarball = files.get(RELEASE_TARBALL_FILENAME);
  verifyTarballBuffer(tarball);
  if (files.get("SHA256SUMS").toString("utf8") !== checksum(files))
    throw new Error("candidate_build_checksum_mismatch");
  const record = validateCandidateRecord(
    {
      schema: SCHEMA,
      version: PACKAGE_VERSION,
      source,
      package: { name: RELEASE_TARBALL_FILENAME, bytes: tarball.length, sha256: sha256(tarball) },
    },
    tarball,
  );
  const bytes = canonical(record);
  writeFileSync(join(directory, CANDIDATE_FILE), bytes, { flag: "wx" });
  files.set(CANDIDATE_FILE, Buffer.from(bytes));
  writeFileSync(join(directory, "SHA256SUMS"), checksum(files));
  return loadCandidate(directory);
}

export function assembleCandidate(directory, destination, pinFile) {
  const { files } = loadCandidate(directory);
  const pin = readFileSync(pinFile);
  if (pin.toString("utf8") !== canonical(validatePinnedRecord(JSON.parse(pin))))
    throw new Error("candidate_core_pin_not_canonical");
  if (files.has("DOCWEN-CORE.json") && !files.get("DOCWEN-CORE.json").equals(pin))
    throw new Error("candidate_core_pin_changed");
  files.set("DOCWEN-CORE.json", pin);
  files.set("SHA256SUMS", Buffer.from(checksum(files)));
  mkdirSync(destination, { recursive: false });
  for (const [name, bytes] of files) writeFileSync(join(destination, name), bytes, { flag: "wx" });
  return loadCandidate(destination, true);
}

export function artifactAttempt(artifact) {
  const match = /^openclaw-docwen-(build|publication)-([1-9]\d*)-([1-9]\d*)$/u.exec(artifact?.name ?? "");
  if (!match || Number(match[2]) !== artifact.workflow_run?.id || !positive(Number(match[3]))) {
    throw new Error("candidate_artifact_name_invalid");
  }
  return { kind: match[1], runId: Number(match[2]), attempt: Number(match[3]) };
}

export function validateArtifactTransport(
  artifact,
  run,
  { id, digest, repositoryId, jobs, publish = false },
) {
  const source = artifactAttempt(artifact);
  if (!run || !Array.isArray(jobs?.jobs)) throw new Error("candidate_artifact_transport_rejected");
  const producerName =
    source.kind === "publication" ? "verify-release" : "Prepare or reuse the exact plugin candidate";
  const producers = jobs?.jobs?.filter((job) => job.name === producerName) ?? [];
  if (
    !positive(id) ||
    !positive(repositoryId) ||
    !/^sha256:[0-9a-f]{64}$/u.test(digest ?? "") ||
    artifact.id !== id ||
    artifact.expired !== false ||
    artifact.digest !== digest ||
    artifact.workflow_run.repository_id !== repositoryId ||
    artifact.workflow_run.head_repository_id !== repositoryId ||
    artifact.workflow_run.head_sha !== run.head_sha ||
    run.id !== source.runId ||
    run.run_attempt !== source.attempt ||
    run.repository?.id !== repositoryId ||
    run.head_repository?.id !== repositoryId ||
    run.path !== ".github/workflows/release.yml" ||
    !["push", "workflow_dispatch"].includes(run.event) ||
    run.status !== "completed" ||
    (publish && source.kind !== "publication") ||
    jobs?.total_count !== jobs?.jobs?.length ||
    producers.length !== 1 ||
    producers[0].run_id !== source.runId ||
    producers[0].head_sha !== run.head_sha ||
    producers[0].status !== "completed" ||
    producers[0].conclusion !== "success"
  ) {
    throw new Error("candidate_artifact_transport_rejected");
  }
  return source;
}

export async function assertSourceAccepted(api, source, defaultBranch, currentCommit) {
  const original = await api.read(`git/commits/${source.commit}`);
  if (original?.sha !== source.commit || original.tree?.sha !== source.tree)
    throw new Error("candidate_source_tree_mismatch");
  const reference = await api.read(`git/ref/heads/${encodeURIComponent(defaultBranch)}`);
  const head = reference?.object?.sha;
  if (reference?.object?.type !== "commit" || !commitId(head) || (currentCommit && currentCommit !== head)) {
    throw new Error("candidate_default_branch_mismatch");
  }
  if (head === source.commit) return "same_commit";
  const main = await api.read(`git/commits/${head}`);
  if (main?.tree?.sha === source.tree) return "same_tree";
  const comparison = await api.read(`compare/${source.commit}...${head}`);
  if (
    comparison?.merge_base_commit?.sha === source.commit &&
    ["ahead", "identical"].includes(comparison.status)
  ) {
    return "ancestor";
  }
  throw new Error("candidate_source_not_accepted");
}

function checked(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", shell: false, windowsHide: true });
  if (result.status !== 0)
    throw new Error(`candidate_command_failed:${command}:${result.stderr?.slice(-2000)}`);
  return result.stdout.trim();
}

export function verifyCandidateProvenance(directory, record, repository) {
  if (record.source.repository.toLowerCase() !== repository.toLowerCase())
    throw new Error("candidate_repository_mismatch");
  for (const name of [CANDIDATE_FILE, RELEASE_TARBALL_FILENAME])
    checked("gh", [
      "attestation",
      "verify",
      join(directory, name),
      "--repo",
      repository,
      "--signer-workflow",
      `${repository}/.github/workflows/release.yml`,
      "--source-ref",
      record.source.ref,
      "--source-digest",
      record.source.commit,
      "--deny-self-hosted-runners",
    ]);
}

function output(values) {
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      Object.entries(values)
        .map(([key, value]) => `${key}=${value}\n`)
        .join(""),
    );
  process.stdout.write(canonical(values));
}

async function main() {
  const [mode, directory, destination, pinFile] = process.argv.slice(2);
  const env = process.env;
  if (mode === "artifact" && process.argv.length === 3) {
    const api = githubApi(env.GITHUB_REPOSITORY, env.GH_TOKEN);
    const id = Number(env.CANDIDATE_ARTIFACT_ID);
    if (!positive(id)) throw new Error("candidate_artifact_id_invalid");
    const artifact = await api.read(`actions/artifacts/${id}`);
    const attempt = artifactAttempt(artifact);
    const run = await api.read(`actions/runs/${attempt.runId}/attempts/${attempt.attempt}`);
    const jobs = await api.read(
      `actions/runs/${attempt.runId}/attempts/${attempt.attempt}/jobs?per_page=100`,
    );
    const source = validateArtifactTransport(artifact, run, {
      id,
      digest: env.CANDIDATE_ARTIFACT_DIGEST,
      repositoryId: Number(env.GITHUB_REPOSITORY_ID),
      jobs,
      publish: env.RELEASE_MODE === "publish",
    });
    output({ run_id: source.runId });
    return;
  }
  if (!directory) throw new Error("candidate_directory_required");
  let candidate;
  if (mode === "record" && process.argv.length === 4) {
    if (checked("git", ["status", "--porcelain", "--untracked-files=all"]))
      throw new Error("candidate_source_dirty");
    const commit = checked("git", ["rev-parse", "HEAD"]);
    if (commit !== env.GITHUB_SHA || (env.RELEASE_VERSION && env.RELEASE_VERSION !== PACKAGE_VERSION))
      throw new Error("candidate_source_mismatch");
    candidate = recordCandidate(directory, {
      repository: env.GITHUB_REPOSITORY,
      commit,
      tree: checked("git", ["rev-parse", "HEAD^{tree}"]),
      ref: env.GITHUB_REF,
      run_id: Number(env.GITHUB_RUN_ID),
      run_attempt: Number(env.GITHUB_RUN_ATTEMPT),
    });
  } else if (mode === "verify" && process.argv.length === 4) {
    candidate = loadCandidate(directory, env.RELEASE_MODE === "publish");
    verifyCandidateProvenance(directory, candidate.record, env.GITHUB_REPOSITORY);
  } else if (mode === "assemble" && process.argv.length === 6) {
    candidate = assembleCandidate(directory, destination, pinFile);
  } else
    throw new Error(
      "usage:release-candidate.mjs artifact|record|verify|assemble [directory] [destination pin]",
    );
  output({
    version: candidate.record.version,
    source_commit: candidate.record.source.commit,
    source_ref: candidate.record.source.ref,
    source_tree: candidate.record.source.tree,
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
