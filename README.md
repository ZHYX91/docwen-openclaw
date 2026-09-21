# DocWen for OpenClaw

Typed OpenClaw tools for DocWen Machine Protocol v2 and verified `docwen.artifact_bundle.v3` output graphs.

> Requires DocWen 0.12.0 or later with Machine Protocol v2 and Artifact Bundle v3. Download the plugin from [GitHub Releases](https://github.com/ZHYX91/docwen-openclaw/releases).

## Boundary

- DocWen remains an independently installed product. The plugin never downloads, installs, upgrades, or replaces it.
- Every call uses JSON-RPC 2.0 over Content-Length framed stdio. No DocWen argv, route ID, or legacy CLI JSON envelope enters a tool result.
- Related reads in `docwen_info` share one process. Task capability discovery, planning and execution also share one initialized process, which closes after Bundle validation. Preparation queries retain `readTimeoutMs` response deadlines within the overall `writeTimeoutMs` budget. No process is cached between calls; input and publication integrity checks remain in place.
- Every Machine input has an explicit `kind`, `role`, and case-sensitive relative POSIX `logical_path`. The plugin never guesses document-relative resources from physical paths, the current directory, or disk siblings.
- Supported Gateway hosts are Windows x64 and Ubuntu 24.04 x64. `binaryPath` must be an explicit absolute path to `DocWenCLI.exe` on Windows or the executable `DocWenCLI` on Linux. Release verification runs the actual plugin archive's Machine client against one pinned immutable DocWen release, version 0.12.0 or later, on both platforms. Protocol compatibility is checked separately from the product version.
- The DocWen child receives a bounded environment that preserves the relevant platform home and profile-directory variables, temporary directories, and `DOCWEN_DATA_DIR`, `DOCWEN_CONFIG_DIR`, `DOCWEN_LOG_DIR` and truthy `DOCWEN_LOG_TO_TEMP`. DATA selects a whole profile; CONFIG and LOG override only their components. Relative selectors are resolved before changing the child working directory. Other ambient `DOCWEN_*` variables, credentials and Node options are not forwarded.
- Accepted Artifact Bundles are limited to 256 artifacts, 512 MiB per artifact, and 1 GiB in aggregate. Artifact SHA-256 verification is streamed and fails closed if a file changes while being read.
- Read operations do not retain converter artifacts. Persistent writes are optional and require an OpenClaw allow policy.
- Every persistent write except explicit Markdown in-place numbering commits a complete, integrity-checked Artifact Bundle to an explicit directory.

## Tools

Read tools:

- `docwen_info`
- `docwen_inspect`
- `docwen_resources`
- `docwen_validate_markdown`

Optional write tools:

- `docwen_convert`
- `docwen_number_markdown`
- `docwen_merge_pdfs`
- `docwen_split_pdf`
- `docwen_merge_tables`
- `docwen_merge_images_to_tiff`

The write tools use `outputDir` as the transaction target. If it already exists, the call fails unless the caller explicitly sets `overwrite=true`. A local IPC lock rejects concurrent writers, the destination observed before conversion is rechecked immediately before the swap, and every copied artifact is revalidated. The committed directory contains exactly the Bundle's logical artifact paths. Hashes, entries and relations remain in the structured result; no hidden manifest is added.

Publication and rollback never replace a newly appearing target. Windows uses native directory rename semantics; Linux x64 uses the included minimal Node-API component for `renameat2(RENAME_NOREPLACE)`. Files use an exclusive hard link on both systems. Unsupported filesystems fail explicitly. See [the component's source and build instructions](native/README.md).

Write results contain `status` (`success`, `warning`, `failed` or `unconfirmed`) and `publication` with `state`, `retry` and structured `warnings`. A committed result remains `published` if backup, staging or lock cleanup fails, and includes usable output paths. An uncertain publication or failed rollback is `unconfirmed`, includes recovery paths, and must not be retried automatically. A failure known to precede publication is `not_published`; review its cause before retrying. Cancellation is checked before the commit begins; once that boundary is crossed, the transaction completes or restores the previous output.

Failed calls, completed writes and Markdown validation results include `diagnostic_summary`, a shareable snapshot containing only controlled error categories, local codes, publication facts, counts and a `recovery_action`. Unknown producer codes become `remote_error`; a producer's `reported_retryable` flag never authorizes a new write. Preview and copy this object when sharing diagnostics. The full operational result can contain document content, raw errors, output paths and recovery paths and is not a redacted diagnostic export.

Recovery actions describe the next review, not an automatic operation: changed sources require preparation from the current content, changed destinations require inspection, existing targets require a new destination or separately authorized replacement, and busy output locks require waiting for the active writer. Published cleanup warnings keep the valid outputs; unconfirmed results require review of the preserved recovery paths. Do not apply positions or repairs from a report to a changed source without revalidation.

Output locks use a Windows named pipe or a Linux abstract Unix-domain socket derived from the canonical destination. The operating system releases them when the owning process exits. There are no lock files, PID-based stale-lock deletion, TCP listeners, or network requests. This follows [Node's IPC lifetime contract](https://nodejs.org/docs/latest-v24.x/api/net.html#ipc-support).

`docwen_convert`, `docwen_merge_pdfs`, `docwen_merge_tables`, and `docwen_merge_images_to_tiff` accept typed `inputs` rather than path lists. Each item contains `{ file, kind, role, logicalPath }`. `logicalPath` is a unique, normalized relative POSIX key in the request virtual root; it is not derived from `file`. For example, a Markdown source at `doc/report.md` can reference the explicitly supplied linked PNG at `doc/assets/chart.png` even when their physical files are in unrelated directories.

The `convert.markdown.to_docx` Machine capability is intentionally different from ordinary source-based conversions: it accepts exactly one `neutral_document` document and one `numbering_export_plan` resource. These roles bind JSON files to `application/vnd.docwen.resolved-document+json` and `application/vnd.docwen.numbering-export-plan+json`; `source`, `linked_resource`, bibliography, citation-style, or additional inputs are rejected for this capability.

`docwen_convert` accepts an optional `optimization` resource ID. It selects a unique available transform capability whose `optimization_id`, typed input shape, and output media type match the request. A resource listing alone does not make an optimizer executable. Legacy Word inputs also require an available preconversion chain; an unavailable or ambiguous optimization fails without reverting to ordinary conversion. Options must satisfy the selected capability's contract.

`docwen_number_markdown` is the sole exception: it requires exactly one of an `outputDir` or `inPlace=true`. In-place replacement is performed only after the returned artifact has passed path, graph, size, and SHA-256 validation.

## Local development

```bash
npm ci
npm run check
npx openclaw plugins validate --root . --entry ./dist/index.js
```

Use `openclaw-config.example.json5` as the configuration shape.

The source suite exercises cancellation at accepted/running protocol frames through the registered tool adapter and a controlled real subprocess. Publication tests inject cancellation and competing writes at the final filesystem commit, checking original bytes, reported publication state, lock release and temporary cleanup. These deterministic tests do not constitute live Gateway or LLM acceptance; record those host checks separately against the exact package.

Final packaged-D2 acceptance uses `npm run acceptance:docwen-package`. It requires the exact extracted `DocWenCLI` path plus its SHA-256, byte size, and stable version at least 0.12.0 through `DOCWEN_TEST_BINARY`, `DOCWEN_TEST_SHA256`, `DOCWEN_TEST_SIZE_BYTES`, and `DOCWEN_TEST_VERSION`. Set `DOCWEN_PLUGIN_CANDIDATE_DIR` to the absolute directory containing the plugin tarball, `CANDIDATE.json` and `SHA256SUMS` from the candidate workflow. The wrapper verifies and extracts that archive into owned temporary storage, loads its compiled client, and rechecks both candidates after the real Machine round trip. It uses an isolated DocWen profile and removes successful temporary work.

## Release asset

Maintainers can create a local package in an explicit directory outside the repository; the command compiles once in an owned temporary directory, runs actual `npm pack`, verifies the complete archive, and writes a stable checksum manifest. Successful work is removed; failed work retains a process-bound lease under the workspace temp directory (or `build` in a standalone clone). CI and release share `check:source` and then this single package build. Build artifacts transfer by exact ID with digest mismatch rejection; reproducibility comparisons are optional engineering checks.

```bash
npm run release:build -- /absolute/path/to/new-output-directory
```

The local command creates exactly these release-build outputs:

- `openclaw-docwen-3.0.0.tgz`
- `SHA256SUMS`

The workflow adds `CANDIDATE.json`, which binds the version, tarball size and SHA-256 to its original repository, commit, full tree, ref, run and attempt. The tarball and this record receive provenance at build time. The immutable GitHub Release also publishes `DOCWEN-CORE.json`, pinning one supported numeric DocWen tag and the exact Linux and Windows asset identities, sizes and SHA-256 digests used by both packaged acceptance jobs. Published `SHA256SUMS` covers the other three assets.

Ordinary releases use a numeric `x.y.z` tag matching `package.json`: the workflow checks source, builds once, verifies both platforms, publishes and independently reads back the result. Selected host acceptance can instead use this handoff:

1. Dispatch `Release` on the candidate branch with mode `candidate` and no artifact inputs. This checks source and retains one plugin package with its original provenance, without requiring an already published Core release. Save the artifact ID and digest from the run summary and use these exact bytes for the selected host checks.
2. Once the required Core release is public, dispatch mode `verify` with that `candidate_artifact_id` and `candidate_artifact_digest`. Both platform checks use the retained plugin bytes and one Core pin. Save the resulting publication artifact ID and digest. Omitting the artifact inputs in `verify` builds a fresh candidate first.
3. After the default branch accepts the candidate source, dispatch mode `publish` on that branch with the verified publication ID and digest. This reuses the archive and Core pin without recompiling or rerunning completed package tests. Source acceptance requires the original commit, its ancestry, or an identical full tree after squash/rebase; the numeric tag always points to the original candidate commit.

Artifact reuse verifies the exact ID, digest, repository, workflow attempt and successful producer job, then checks the original source provenance. A publication artifact remains usable if a later publishing job failed. Resume with that same publication artifact; an existing Core pin cannot silently resolve to a newer release. These modes support checks selected for the current change and do not add a standing manual approval requirement.

Publication requires GitHub Immutable Releases and an active repository ruleset that prevents updates or
deletion of numeric `x.y.z` tags. Final release state is read back through the REST `immutable: true` field.

Publication creates a draft first and resumes matching drafts by uploading only missing assets. Existing names with different bytes, incomplete uploads, or unexpected assets stop publication; nothing is overwritten or deleted. After a write loses its response, the publisher reads the release again before deciding whether the operation completed. A complete matching immutable release is a read-only no-op. One independent post-verification job downloads the public assets and checks their bytes and provenance.

After obtaining that exact tarball, install it with OpenClaw:

```bash
openclaw plugins install ./openclaw-docwen-3.0.0.tgz
```

## Package structure

- `src/plugin.ts`: thin OpenClaw plugin composition.
- `src/config.ts`: strict plugin configuration schema.
- `src/tools/`: tool catalog and parameter schemas.
- `src/docwen/machine-framing.ts`: canonical Content-Length framing.
- `src/docwen/machine-client.ts`: Machine v2 lifecycle, cancellation, and strict Bundle validation.
- `src/docwen/client.ts`: capability selection plus consumer-owned transactional commits.
- `src/docwen/output-lock.ts`: OS-owned Windows/Linux output locking and release.
- `src/process/runner.ts`: process-tree termination for cancellation and failure containment.
- `skills/docwen/SKILL.md`: model-facing usage and safety rules.
