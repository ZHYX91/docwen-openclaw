# DocWen for OpenClaw

Use DocWen from OpenClaw to check documents, convert files, and work with PDFs and spreadsheets. The files stay on your Gateway computer; the plugin talks to a locally installed DocWen rather than sending them to an online conversion service.

Install **DocWen 0.12.0 or later** separately before using this plugin. You also need a release that supports Machine Protocol v2 and Artifact Bundle v3. [Download the plugin](https://github.com/ZHYX91/docwen-openclaw/releases).

## What you can do

- Check a file's format and see which conversions are available.
- Check Markdown for problems without editing the original.
- Convert documents, merge or split PDFs, and combine spreadsheets or images.

File-changing tools are **off by default**. You choose which ones OpenClaw may use, and where results are saved.

## Quick start

1. **Install DocWen separately.** On a supported Windows x64 or Ubuntu 24.04 x64 Gateway host, install a compatible [DocWen release](https://github.com/ZHYX91/docwen/releases) (0.12.0 or later) with Machine Protocol v2 and Artifact Bundle v3. Find the full absolute path to `DocWenCLI.exe` on Windows or `DocWenCLI` on Linux. Installing this plugin does **not** install DocWen.
2. **Install the OpenClaw plugin.** Download the matching `openclaw-docwen-X.Y.Z.tgz` asset from [this plugin's release page](https://github.com/ZHYX91/docwen-openclaw/releases) and install it on the Gateway host:

   ```sh
   openclaw plugins install ./openclaw-docwen-X.Y.Z.tgz
   ```

3. **Point the plugin to DocWen.** Start with the read-only [`openclaw-config.example.json5`](openclaw-config.example.json5). Replace `plugins.entries.docwen.config.binaryPath` with the actual absolute DocWenCLI path on **your Gateway host**; on Linux use the installed executable. Its tool allow list is:

   ```json5
   tools: {
     allow: ["docwen_info", "docwen_inspect", "docwen_resources", "docwen_validate_markdown"],
   }
   ```

   To authorize conversion later, add the specific write tool, such as `"docwen_convert"`, to that list. Allowing `"docwen"` enables the entire group, including all write tools.

4. **Test the connection without changing files.** First call `docwen_info` to check the local executable, protocol, and capabilities. Use `docwen_inspect` to identify an unfamiliar file, `docwen_resources` to choose supported formats or templates, and `docwen_validate_markdown` to check Markdown without writing it. Enable the relevant write tools only after reviewing their allow policy, the destination `outputDir`, and any overwrite or in-place options.

**Before enabling changes:** Conversion tools need exact input paths and an output folder on the Gateway computer. They do not replace an existing folder unless `overwrite=true` is explicitly allowed. If a write's result is uncertain, the plugin will not retry it automatically. See [Write safety](skills/docwen/SKILL.md) for details.

On Linux, the selected output filesystem must support atomic no-replace publication. Some mounted Windows drives in WSL cannot provide it; choose a native Linux output folder if the filesystem is rejected. Support is determined by the actual operation, not the folder's name.

## Language

Set `plugins.entries.docwen.config.language` to one of the supported DocWen language codes, or leave it as `auto`. For Arabic, use `ar_SA` with a DocWen installation that includes its Arabic locale. This controls the language requested from DocWen; the OpenClaw tool labels and descriptions remain in English.

## How it works

OpenClaw calls the local DocWen executable. Checking a file does not change it; converting or merging files requires a separate write-tool permission and an output folder that you choose. The plugin validates results before saving them and does not automatically repeat an uncertain write.

Paths must refer to files on the **Gateway computer**, not another device connected to OpenClaw. See the [technical and safety details](docs/technical-details.md) for the exact input rules, cancellation behavior, and recovery states.

## Tools

Read-only tools:

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

The first four tools are read-only. The remaining tools are optional and must be explicitly allowed in OpenClaw. Keep the read-only allow list until you need to write files. For the complete input shapes and safeguards, see [the technical details](docs/technical-details.md).

## Local development

```bash
npm ci
npm run check
npx openclaw plugins validate --root . --entry ./dist/index.js
```

Use `openclaw-config.example.json5` as the configuration shape.

The source suite exercises cancellation at accepted/running protocol frames through the registered tool adapter and a controlled real subprocess. Publication tests inject cancellation and competing writes at the final filesystem commit, checking original bytes, reported publication state, lock release and temporary cleanup. These deterministic tests do not constitute live Gateway or LLM acceptance; record those host checks separately against the exact package.

Final packaged-D2 acceptance uses `npm run acceptance:docwen-package`. It requires the exact extracted `DocWenCLI` path plus its SHA-256, byte size, and stable version at least 0.12.0 through `DOCWEN_TEST_BINARY`, `DOCWEN_TEST_SHA256`, `DOCWEN_TEST_SIZE_BYTES`, and `DOCWEN_TEST_VERSION`. Set `DOCWEN_PLUGIN_CANDIDATE_DIR` to the absolute directory containing the plugin tarball, `CANDIDATE.json` and `SHA256SUMS` from the candidate workflow. The wrapper verifies and extracts that archive into owned temporary storage, loads its compiled client, and rechecks both candidates after the real Machine round trip. It uses an isolated DocWen profile and removes successful temporary work.

## Releases

Install a plugin release from the [GitHub Releases page](https://github.com/ZHYX91/docwen-openclaw/releases). For building, testing, verifying and publishing a release, see the [maintainer release guide](docs/releasing.md). Installing this plugin never installs or upgrades DocWen.

For a map of the source files, see the [technical details](docs/technical-details.md).
