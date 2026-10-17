# Technical details: DocWen for OpenClaw

This reference explains the implementation and safety boundaries behind the short [README](../README.md). It is intended for maintainers and for anyone automating file writes.

## Configuration

Put these settings under `plugins.entries.docwen.config`. The [example configuration](../openclaw-config.example.json5) starts with read-only tools enabled.

| Setting          | Default            | Purpose                                                                                  |
| ---------------- | ------------------ | ---------------------------------------------------------------------------------------- |
| `binaryPath`     | Must be configured | Full path to `DocWenCLI.exe` on Windows or `DocWenCLI` on Linux, on the Gateway computer |
| `language`       | `auto`             | Language requested from the installed DocWen                                             |
| `readTimeoutMs`  | `30000`            | Time limit for read requests, in milliseconds                                            |
| `writeTimeoutMs` | `600000`           | Overall time limit for preparing and running a document task, in milliseconds            |

Both time limits accept values from `1000` to `1800000`. With `language: "auto"`, DocWen uses its default language. To request another language, use a code accepted by the [configuration schema](../src/config.ts) and included in your DocWen installation; for example, Arabic uses `ar_SA`. This setting controls DocWen output, templates, and task options where supported. The plugin's OpenClaw tool labels and descriptions remain in English.

## Process, protocol and filesystem boundaries

The plugin starts a local DocWen process for each request. Read-only checks do not publish conversion output; write tools require an explicit destination. The following details explain the safeguards for file paths, process cleanup, and failed writes.

- DocWen remains an independently installed product. The plugin never downloads, installs, upgrades, or replaces it.
- Every call uses JSON-RPC 2.0 over Content-Length framed stdio. No DocWen argv, route ID, or legacy CLI JSON envelope enters a tool result.
- Related reads in `docwen_info` share one process. Task capability discovery, planning and execution also share one initialized process, which closes after Bundle validation. Preparation queries retain `readTimeoutMs` response deadlines within the overall `writeTimeoutMs` budget. No process is cached between calls; input and publication integrity checks remain in place.
- Machine transport failure and shutdown use a separate bounded cleanup phase. Linux uses a bundled lifetime owner that pins its process-group leader until the last cleanup signal, then reaps descendants without retaining stale numeric signal authority. Control-channel loss triggers cleanup; incomplete cleanup remains an explicit failure. The helper requires an executable temporary directory and removes its private image before starting Machine. Windows starts DocWen under the bundled x64 Job Object controller before execution begins, so owned descendants remain terminable after the direct DocWen process exits without name scans or stale-PID targeting. The controller does not retain a duplicate stdin reader, preserving asynchronous broken-pipe detection. Cooperative task cancellation keeps its existing grace period before forced cleanup.
- Every Machine input has an explicit `kind`, `role`, and case-sensitive relative POSIX `logical_path`. The plugin never guesses document-relative resources from physical paths, the current directory, or disk siblings.
- Supported Gateway hosts are Windows x64 and Ubuntu 24.04 x64. `binaryPath` must be an explicit absolute path to `DocWenCLI.exe` on Windows or the executable `DocWenCLI` on Linux. Release verification runs the actual plugin archive's Machine client against one pinned immutable DocWen release, version 0.12.0 or later, on both platforms. Protocol compatibility is checked separately from the product version.
- The DocWen child receives a bounded environment that preserves the relevant platform home and profile-directory variables, temporary directories, and `DOCWEN_DATA_DIR`, `DOCWEN_CONFIG_DIR`, `DOCWEN_LOG_DIR` and truthy `DOCWEN_LOG_TO_TEMP`. DATA selects a whole profile; CONFIG and LOG override only their components. Relative selectors are resolved before changing the child working directory. Other ambient `DOCWEN_*` variables, credentials and Node options are not forwarded.
- Accepted Artifact Bundles are limited to 256 artifacts, 512 MiB per artifact, and 1 GiB in aggregate. Artifact SHA-256 verification is streamed and fails closed if a file changes while being read.
- Read operations do not retain converter artifacts. Persistent writes are optional and require an OpenClaw allow policy.
- Every persistent write except explicit Markdown in-place numbering commits a complete, integrity-checked Artifact Bundle to an explicit directory.

## Tool write behavior

The write tools use `outputDir` as the transaction target. If it already exists, the call fails unless the caller explicitly sets `overwrite=true`. A local IPC lock rejects concurrent writers, the destination observed before conversion is rechecked immediately before the swap, and every copied artifact is revalidated. The committed directory contains exactly the Bundle's logical artifact paths. Hashes, entries and relations remain in the structured result; no hidden manifest is added.

Publication and rollback never replace a newly appearing target. Windows uses native directory rename semantics; Linux x64 uses the included minimal Node-API component for `renameat2(RENAME_NOREPLACE)`. Files use an exclusive hard link on both systems. Unsupported filesystems fail explicitly. See [the component's source and build instructions](../native/README.md).

Write results contain `status` (`success`, `warning`, `failed` or `unconfirmed`) and `publication` with `state`, `retry` and structured `warnings`. A committed result remains `published` if backup, staging or lock cleanup fails, and includes usable output paths. An uncertain publication or failed rollback is `unconfirmed`, includes recovery paths, and must not be retried automatically. A failure known to precede publication is `not_published`; review its cause before retrying. Cancellation is checked before the commit begins; once that boundary is crossed, the transaction completes or restores the previous output.

Failed calls, completed writes and Markdown validation results include `diagnostic_summary`, a shareable snapshot containing only controlled error categories, local codes, publication facts, counts and a `recovery_action`. When process cleanup also fails, the primary operation error stays intact and `process_cleanup` separately reports its controlled code and reason. Unknown producer codes become `remote_error`; a producer's `reported_retryable` flag never authorizes a new write. Preview and copy this object when sharing diagnostics. The full operational result can contain document content, raw errors, output paths and recovery paths and is not a redacted diagnostic export.

Recovery actions describe the next review, not an automatic operation: changed sources require preparation from the current content, changed destinations require inspection, existing targets require a new destination or separately authorized replacement, and busy output locks require waiting for the active writer. Published cleanup warnings keep the valid outputs; unconfirmed results require review of the preserved recovery paths. Do not apply positions or repairs from a report to a changed source without revalidation.

Output locks use a Windows named pipe or a Linux abstract Unix-domain socket derived from the canonical destination. The operating system releases them when the owning process exits. There are no lock files, PID-based stale-lock deletion, TCP listeners, or network requests. This follows [Node's IPC lifetime contract](https://nodejs.org/docs/latest-v24.x/api/net.html#ipc-support).

`docwen_convert`, `docwen_merge_pdfs`, `docwen_merge_tables`, and `docwen_merge_images_to_tiff` accept typed `inputs` rather than path lists. Each item contains `{ file, kind, role, logicalPath }`. `logicalPath` is a unique, normalized relative POSIX key in the request virtual root; it is not derived from `file`. For example, a Markdown source at `doc/report.md` can reference the explicitly supplied linked PNG at `doc/assets/chart.png` even when their physical files are in unrelated directories.

For an ordinary Markdown-to-Word task, use a Markdown `source` document and explicitly supplied `linked_resource` images. This requires the installed DocWen to advertise `convert.markdown_source.to_docx`. The plugin chooses the capability from the actual input roles and target format; it does not manufacture parsed document JSON when the source-based capability is unavailable.

The separate `convert.markdown.to_docx` capability is for integrations that already have a resolved document and numbering plan. It accepts exactly one `neutral_document` document and one `numbering_export_plan` resource. These roles bind JSON files to `application/vnd.docwen.resolved-document+json` and `application/vnd.docwen.numbering-export-plan+json`; `source`, `linked_resource`, bibliography, citation-style, or additional inputs are rejected only for this resolved-document capability. See [the examples](examples/basic.md) for the ordinary Markdown input form.

`docwen_convert` accepts an optional `optimization` resource ID. It selects a unique available transform capability whose `optimization_id`, typed input shape, and output media type match the request. A resource listing alone does not make an optimizer executable. Legacy Word inputs also require an available preconversion chain; an unavailable or ambiguous optimization fails without reverting to ordinary conversion. Options must satisfy the selected capability's contract.

`docwen_number_markdown` is the sole exception: it requires exactly one of an `outputDir` or `inPlace=true`. In-place replacement is performed only after the returned artifact has passed path, graph, size, and SHA-256 validation.

## Testing and package acceptance

The source suite exercises cancellation at accepted/running protocol frames through the registered tool adapter and a controlled real subprocess. Publication tests inject cancellation and competing writes at the final filesystem commit, checking original bytes, reported publication state, lock release and temporary cleanup. These deterministic tests do not constitute live Gateway or LLM acceptance; record those host checks separately against the exact package.

Run `npm run acceptance:docwen-package` to verify the packaged plugin against a packaged DocWen release. It requires the exact extracted `DocWenCLI` path plus its SHA-256, byte size, and stable version at least 0.12.0 through `DOCWEN_TEST_BINARY`, `DOCWEN_TEST_SHA256`, `DOCWEN_TEST_SIZE_BYTES`, and `DOCWEN_TEST_VERSION`. Set `DOCWEN_PLUGIN_CANDIDATE_DIR` to the absolute directory containing the plugin tarball, `CANDIDATE.json` and `SHA256SUMS` from the candidate workflow. The wrapper verifies and extracts that archive into owned temporary storage, loads its compiled client, and rechecks both candidates after the real Machine round trip. It uses an isolated DocWen profile and removes successful temporary work.

## Source layout

- `src/plugin.ts`: thin OpenClaw plugin composition.
- `src/config.ts`: strict plugin configuration schema.
- `src/tools/`: tool catalog and parameter schemas.
- `src/docwen/machine-framing.ts`: canonical Content-Length framing.
- `src/docwen/machine-client.ts`: Machine v2 lifecycle, cancellation, and strict Bundle validation.
- `src/docwen/client.ts`: capability selection plus consumer-owned transactional commits.
- `src/docwen/output-lock.ts`: OS-owned Windows/Linux output locking and release.
- `src/process/runner.ts`: process-tree termination for cancellation and failure containment.
- [`skills/docwen/SKILL.md`](../skills/docwen/SKILL.md): model-facing usage and safety rules.
