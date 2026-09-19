# DocWen for OpenClaw

Typed OpenClaw tools for DocWen Machine Protocol v2 and verified `docwen.artifact_bundle.v3` output graphs.

> Version 2.0.0 is published as an [immutable GitHub Release](https://github.com/ZHYX91/docwen-openclaw/releases/tag/2.0.0).

## Boundary

- DocWen remains an independently installed product. The plugin never downloads, installs, upgrades, or replaces it.
- Every call uses JSON-RPC 2.0 over Content-Length framed stdio. No DocWen argv, route ID, or legacy CLI JSON envelope enters a tool result.
- Every Machine input has an explicit `kind`, `role`, and case-sensitive relative POSIX `logical_path`. The plugin never guesses document-relative resources from physical paths, the current directory, or disk siblings.
- The 2.0 Gateway hosts are Windows x64 and Ubuntu 24.04 x64. `binaryPath` must be an explicit absolute path to `DocWenCLI.exe` on Windows or the executable `DocWenCLI` on Linux. Release preflight runs the packaged Machine round trip against the exact immutable DocWen 0.9 package on both platforms.
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

Final packaged-D2 acceptance uses `npm run acceptance:docwen-package`. It requires the exact extracted `DocWenCLI` path plus its SHA-256, byte size, and stable 0.9.x version through `DOCWEN_TEST_BINARY`, `DOCWEN_TEST_SHA256`, `DOCWEN_TEST_SIZE_BYTES`, and `DOCWEN_TEST_VERSION`; the wrapper revalidates the candidate before and after the real Machine round trip.

## Release asset

Maintainers create the 2.0.0 candidate in an explicit directory outside the repository; the command performs two isolated clean builds and actual `npm pack` runs, rejects non-identical tarballs, verifies the complete archive, and writes a stable checksum manifest.

```bash
npm run release:build -- /absolute/path/to/new-output-directory
```

The local command creates exactly these release-build outputs:

- `openclaw-docwen-2.0.0.tgz`
- `SHA256SUMS`

The immutable GitHub Release additionally publishes `DOCWEN-CORE.json`. That canonical record pins
one DocWen 0.9.x tag and the exact Linux and Windows asset identities, sizes, and SHA-256 digests used
by both packaged acceptance jobs. The published `SHA256SUMS` covers both the plugin tarball and this
dependency record.

Publication requires GitHub Immutable Releases and an active repository ruleset that prevents updates or
deletion of numeric `x.y.z` tags. Final release state is read back through the REST `immutable: true` field.

After obtaining that exact tarball, install it with OpenClaw:

```bash
openclaw plugins install ./openclaw-docwen-2.0.0.tgz
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
