import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { setTimeout as pause } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { validatePinnedRecord } from "./fetch-docwen-release.mjs";
import { PACKAGE_VERSION, RELEASE_TARBALL_FILENAME, verifyTarballBuffer } from "./release-package-lib.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

export function loadPublication(directory, version) {
  if (version !== PACKAGE_VERSION || !stableVersion.test(version))
    throw new Error("publication_version_invalid");
  const expected = ["DOCWEN-CORE.json", "SHA256SUMS", RELEASE_TARBALL_FILENAME].sort();
  if (JSON.stringify(readdirSync(directory).sort()) !== JSON.stringify(expected)) {
    throw new Error("publication_file_set_invalid");
  }
  const files = new Map(
    expected.map((name) => {
      const file = join(directory, name);
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > 16 * 1024 * 1024) {
        throw new Error("publication_file_invalid");
      }
      return [name, readFileSync(file)];
    }),
  );
  verifyTarballBuffer(files.get(RELEASE_TARBALL_FILENAME));
  const pinBytes = files.get("DOCWEN-CORE.json").toString("utf8");
  const pin = validatePinnedRecord(JSON.parse(pinBytes));
  if (pinBytes !== `${JSON.stringify(pin)}\n`) throw new Error("publication_core_pin_not_canonical");
  const sums = ["DOCWEN-CORE.json", RELEASE_TARBALL_FILENAME]
    .map((name) => `${sha256(files.get(name))}  ${name}\n`)
    .join("");
  if (files.get("SHA256SUMS").toString("utf8") !== sums) throw new Error("publication_checksum_mismatch");
  return files;
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

export function githubApi(repository, token, fetch = globalThis.fetch, wait = pause) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository) || !token)
    throw new Error("publication_github_context_invalid");
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2026-03-10",
    "User-Agent": "docwen-openclaw-release",
  };
  const request = async (method, endpoint, body, upload = false) => {
    const origin = upload ? "https://uploads.github.com" : "https://api.github.com";
    const response = await fetch(`${origin}/repos/${repository}/${endpoint}`, {
      method,
      headers: { ...headers, "Content-Type": upload ? "application/octet-stream" : "application/json" },
      ...(body === undefined ? {} : { body: upload ? body : JSON.stringify(body) }),
      signal: globalThis.AbortSignal.timeout(60_000),
      redirect: "error",
    });
    if (method === "GET" && response.status === 404) return null;
    if (!response.ok)
      throw Object.assign(new Error(`publication_github_http_${response.status}`), {
        status: response.status,
      });
    return response.json();
  };
  return {
    async read(endpoint) {
      for (let attempt = 0; ; attempt++) {
        try {
          return await request("GET", endpoint);
        } catch (error) {
          if (attempt >= 2 || (error.status !== undefined && error.status !== 429 && error.status < 500))
            throw error;
          await wait(1000 * (attempt + 1));
        }
      }
    },
    write: (method, endpoint, body) => request(method, endpoint, body),
    upload: (id, name, bytes) =>
      request("POST", `releases/${id}/assets?name=${encodeURIComponent(name)}`, bytes, true),
  };
}

async function main() {
  const [mode, directory] = process.argv.slice(2);
  if (!["inspect", "publish"].includes(mode) || !directory || process.argv.length !== 4)
    throw new Error("usage:publish-release.mjs inspect|publish <directory>");
  const version = process.env.RELEASE_VERSION;
  const commit = process.env.GITHUB_SHA;
  const files = loadPublication(directory, version);
  const api = githubApi(process.env.GITHUB_REPOSITORY, process.env.GH_TOKEN);
  const result =
    mode === "publish"
      ? await publishRelease(api, { version, commit, files })
      : (await verifyTag(api, version, commit),
        inspectRelease(await api.read(`releases/tags/${version}`), version, files));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
