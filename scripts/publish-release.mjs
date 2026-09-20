import { createHash } from "node:crypto";
import { resolve } from "node:path";
import process from "node:process";
import { setTimeout as pause } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { githubApi } from "./release-github.mjs";
import { assertSourceAccepted, loadCandidate, verifyCandidateProvenance } from "./release-candidate.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

export function loadPublication(directory, version) {
  const candidate = loadCandidate(directory, true);
  if (candidate.record.version !== version) throw new Error("publication_version_invalid");
  return candidate.files;
}

export function inspectRelease(release, version, files, allowPendingImmutable = false) {
  if (release === null) return { decision: "create", missing: [...files.keys()] };
  if (
    !Number.isSafeInteger(release.id) ||
    release.id <= 0 ||
    release.tag_name !== version ||
    release.prerelease !== false ||
    typeof release.draft !== "boolean" ||
    !Array.isArray(release.assets)
  ) {
    throw new Error("publication_release_identity_invalid");
  }
  const immutable =
    release.immutable === true && typeof release.published_at === "string" && Boolean(release.published_at);
  if (!release.draft && !immutable && !allowPendingImmutable) {
    throw new Error("publication_public_release_not_immutable");
  }
  const present = new Set();
  for (const asset of release.assets) {
    const bytes = files.get(asset.name);
    if (
      !bytes ||
      present.has(asset.name) ||
      !Number.isSafeInteger(asset.id) ||
      asset.id <= 0 ||
      asset.state !== "uploaded" ||
      asset.size !== bytes.length ||
      asset.digest !== `sha256:${sha256(bytes)}`
    ) {
      throw new Error("publication_existing_asset_conflict");
    }
    present.add(asset.name);
  }
  const missing = [...files.keys()].filter((name) => !present.has(name));
  if (!release.draft && missing.length) throw new Error("publication_immutable_assets_missing");
  return {
    decision: release.draft ? "draft" : immutable ? "noop" : "pending",
    releaseId: release.id,
    missing,
  };
}

export async function verifyTag(api, version, commit) {
  if (!stableVersion.test(version) || !/^[0-9a-f]{40}$/u.test(commit))
    throw new Error("publication_source_invalid");
  let object = (await api.read(`git/ref/tags/${version}`))?.object;
  for (let depth = 0; object?.type === "tag" && depth < 5; depth++) {
    if (!/^[0-9a-f]{40}$/u.test(object.sha)) throw new Error("publication_tag_invalid");
    object = (await api.read(`git/tags/${object.sha}`))?.object;
  }
  if (object?.type !== "commit" || object.sha !== commit) throw new Error("publication_tag_mismatch");
}

export async function ensureTag(api, version, commit, allowCreate = false) {
  if (!stableVersion.test(version) || !/^[0-9a-f]{40}$/u.test(commit))
    throw new Error("publication_source_invalid");
  if (allowCreate && (await api.read(`git/ref/tags/${version}`)) === null) {
    let failure;
    try {
      await api.write("POST", "git/refs", { ref: `refs/tags/${version}`, sha: commit });
    } catch (error) {
      failure = error;
    }
    try {
      await verifyTag(api, version, commit);
    } catch (error) {
      throw failure ?? error;
    }
    return;
  }
  await verifyTag(api, version, commit);
}

/** Writes once, then reads authoritative state. An unknown write is never blindly repeated. */
export async function publishRelease(api, { version, commit, files }, wait = pause) {
  await verifyTag(api, version, commit);
  const endpoint = `releases/tags/${version}`;
  let release = await api.read(endpoint);
  let state = inspectRelease(release, version, files);
  if (state.decision === "noop") {
    await verifyTag(api, version, commit);
    return state;
  }
  if (state.decision === "create") {
    let failure;
    try {
      await api.write("POST", "releases", {
        tag_name: version,
        target_commitish: commit,
        name: version,
        draft: true,
        prerelease: false,
        generate_release_notes: true,
      });
    } catch (error) {
      failure = error;
    }
    release = await api.read(endpoint);
    if (release === null) throw failure ?? new Error("publication_draft_creation_unconfirmed");
    state = inspectRelease(release, version, files);
  }
  const releaseId = state.releaseId;
  const readState = async (allowPendingImmutable = false) => {
    const current = await api.read(endpoint);
    const inspected = inspectRelease(current, version, files, allowPendingImmutable);
    if (inspected.releaseId !== releaseId) throw new Error("publication_release_replaced");
    return inspected;
  };
  for (const name of files.keys()) {
    state = await readState();
    if (!state.missing.includes(name)) continue;
    await verifyTag(api, version, commit);
    let failure;
    try {
      await api.upload(releaseId, name, files.get(name));
    } catch (error) {
      failure = error;
    }
    state = await readState();
    if (state.missing.includes(name)) throw failure ?? new Error("publication_upload_unconfirmed");
  }
  state = await readState();
  if (state.missing.length) throw new Error("publication_assets_incomplete");
  await verifyTag(api, version, commit);
  if (state.decision !== "noop") {
    let failure;
    try {
      await api.write("PATCH", `releases/${releaseId}`, { draft: false, make_latest: "true" });
    } catch (error) {
      failure = error;
    }
    for (let attempt = 0; attempt < 5; attempt++) {
      state = await readState(true);
      if (state.decision === "noop") break;
      if (attempt === 4) throw failure ?? new Error("publication_finalization_unconfirmed");
      await wait(1000);
    }
  }
  await verifyTag(api, version, commit);
  return { ...state, decision: "published" };
}

async function main() {
  const [mode, directory] = process.argv.slice(2);
  if (!["inspect", "publish"].includes(mode) || !directory || process.argv.length !== 4)
    throw new Error("usage:publish-release.mjs inspect|publish <directory>");
  const version = process.env.RELEASE_VERSION;
  const { record, files } = loadCandidate(directory, true);
  if (record.version !== version) throw new Error("publication_version_invalid");
  const commit = record.source.commit;
  const api = githubApi(process.env.GITHUB_REPOSITORY, process.env.GH_TOKEN);
  verifyCandidateProvenance(directory, record, process.env.GITHUB_REPOSITORY);
  const manual =
    process.env.GITHUB_EVENT_NAME === "workflow_dispatch" && process.env.RELEASE_MODE === "publish";
  if (
    manual
      ? process.env.GITHUB_REF !== `refs/heads/${process.env.DEFAULT_BRANCH}`
      : process.env.GITHUB_REF !== `refs/tags/${version}` || process.env.GITHUB_SHA !== commit
  ) {
    throw new Error("publication_event_boundary_invalid");
  }
  const sourceAcceptance = await assertSourceAccepted(
    api,
    record.source,
    process.env.DEFAULT_BRANCH,
    manual && mode === "publish" ? process.env.GITHUB_SHA : undefined,
  );
  if (mode === "publish") await ensureTag(api, version, commit, manual);
  else if (!manual || (await api.read(`git/ref/tags/${version}`)) !== null)
    await verifyTag(api, version, commit);
  const result =
    mode === "publish"
      ? await publishRelease(api, { version, commit, files })
      : inspectRelease(await api.read(`releases/tags/${version}`), version, files);
  if (mode === "inspect" && result.decision === "noop") await verifyTag(api, version, commit);
  process.stdout.write(
    `${JSON.stringify({ ...result, sourceAcceptance, sourceCommit: commit, sourceTree: record.source.tree })}\n`,
  );
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
