# DocWen for OpenClaw

[English](https://github.com/ZHYX91/docwen-openclaw/blob/main/README.md) · [简体中文](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.zh-CN.md) · [繁體中文](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.zh-TW.md) · [Deutsch](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.de-DE.md) · [Français](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.fr-FR.md) · [Español](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.es-ES.md) · [Português](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.pt-BR.md) · [Русский](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.ru-RU.md) · [日本語](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.ja-JP.md) · [한국어](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.ko-KR.md) · [Tiếng Việt](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.vi-VN.md) · [العربية](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.ar.md)

Use DocWen from OpenClaw to check documents, convert files, and work with PDFs and spreadsheets. The files stay on the computer running your OpenClaw Gateway. The plugin uses DocWen installed on that computer to process them locally.

Install **DocWen 0.12.0 or later** separately before using this plugin. [Download the plugin](https://github.com/ZHYX91/docwen-openclaw/releases).

## What you can do

- Check a file's format and see which conversions are available.
- Check Markdown for problems without editing the original.
- Convert documents, merge or split PDFs, and combine spreadsheets or images.

File-changing tools are **off by default**. You choose which ones OpenClaw may use, and where results are saved.

## Quick start

1. **Install DocWen separately.** On the Windows x64 or Ubuntu 24.04 x64 computer running your Gateway, install a compatible [DocWen release](https://github.com/ZHYX91/docwen/releases) (0.12.0 or later). Find the full absolute path to `DocWenCLI.exe` on Windows or `DocWenCLI` on Linux. Installing this plugin does **not** install DocWen.
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

4. **Test the connection without changing files.** Ask OpenClaw to run `docwen_info` to check that DocWen is ready. Then use `docwen_inspect` to check a file, `docwen_resources` to find a format or template, or `docwen_validate_markdown` to check Markdown. When you want to convert a file, allow the relevant tool and choose its output folder.

Conversion tools need full input paths and an output folder on the Gateway computer. Choose a new folder: `overwrite=true` replaces the entire existing output folder and its contents. Markdown numbering can also update the original file when `inPlace=true` is explicitly requested. If a write's result is uncertain, the plugin will not retry it automatically. See [the examples (Chinese)](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/examples/basic.md) for common tasks and [the configuration reference](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/technical-details.md#configuration) for settings.

On Linux, if the plugin reports that the output filesystem is unsupported, choose a folder on the native Linux filesystem. This can happen with Windows drives mounted in WSL.

## How it works

OpenClaw calls the local DocWen executable. Checking a file does not change it; converting or merging files requires a separate write-tool permission and an output folder that you choose. The plugin validates results before saving them and does not automatically repeat an uncertain write.

Paths must refer to files on the **Gateway computer**, not another device connected to OpenClaw. See the [technical and safety details](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/technical-details.md) for the exact input rules, cancellation behavior, and recovery states.

## Tools

| Tool                          | What it does                                         | Permission       |
| ----------------------------- | ---------------------------------------------------- | ---------------- |
| `docwen_info`                 | Check the DocWen installation and available features | Read-only        |
| `docwen_inspect`              | Identify a file's format and available actions       | Read-only        |
| `docwen_resources`            | Browse formats, templates, and numbering schemes     | Read-only        |
| `docwen_validate_markdown`    | Check Markdown and report problems                   | Read-only        |
| `docwen_convert`              | Convert files into the chosen format                 | Allow separately |
| `docwen_number_markdown`      | Add or remove Markdown heading numbers               | Allow separately |
| `docwen_merge_pdfs`           | Combine PDFs in the given order                      | Allow separately |
| `docwen_split_pdf`            | Extract selected PDF pages                           | Allow separately |
| `docwen_merge_tables`         | Combine spreadsheets                                 | Allow separately |
| `docwen_merge_images_to_tiff` | Combine images into a TIFF                           | Allow separately |

Available conversions depend on your DocWen installation. The plugin checks the advertised features before starting a task. For input fields and write safeguards, see [the technical details](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/technical-details.md).

## Local development

```bash
npm ci
npm run check
npx openclaw plugins validate --root . --entry ./dist/index.js
```

Use `openclaw-config.example.json5` as the configuration shape. See [testing and package acceptance](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/technical-details.md#testing-and-package-acceptance) for the test coverage and checks against a packaged DocWen release.

## Releases

Install a plugin release from the [GitHub Releases page](https://github.com/ZHYX91/docwen-openclaw/releases). For building, testing, verifying and publishing a release, see the [maintainer release guide](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/releasing.md). Installing this plugin never installs or upgrades DocWen.

For a map of the source files, see the [technical details](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/technical-details.md).
