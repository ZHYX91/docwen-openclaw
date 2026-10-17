# DocWen for OpenClaw

[English](https://github.com/ZHYX91/docwen-openclaw/blob/main/README.md) · [简体中文](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.zh-CN.md) · [繁體中文](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.zh-TW.md) · [Deutsch](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.de-DE.md) · [Français](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.fr-FR.md) · [Español](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.es-ES.md) · [Português](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.pt-BR.md) · [Русский](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.ru-RU.md) · [日本語](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.ja-JP.md) · [한국어](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.ko-KR.md) · [Tiếng Việt](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.vi-VN.md) · [العربية](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.ar.md)

在 OpenClaw 中使用 DocWen 检查文档、转换文件，并处理 PDF 和电子表格。文件留在运行 OpenClaw Gateway 的电脑上，由这台电脑安装的 DocWen 在本机处理。

使用本插件前，请先单独安装 **DocWen 0.12.0 或更高版本**。[下载插件](https://github.com/ZHYX91/docwen-openclaw/releases)。

## 能做什么

- 查看文件格式和可用的转换方式。
- 检查 Markdown 中的问题，不改动原文件。
- 转换文档、合并或拆分 PDF，以及合并电子表格或图片。

会写入或修改文件的工具**默认关闭**。由你决定 OpenClaw 可以使用哪些工具，以及结果保存在哪里。

## 快速开始

1. **单独安装 DocWen。** 在运行 Gateway 的 Windows x64 或 Ubuntu 24.04 x64 电脑上，安装兼容的 [DocWen 版本](https://github.com/ZHYX91/docwen/releases)（0.12.0 或更高版本）。找到 Windows 上 `DocWenCLI.exe` 或 Linux 上 `DocWenCLI` 的完整绝对路径。安装本插件**不会同时安装 DocWen**。
2. **安装 OpenClaw 插件。** 从[插件发布页面](https://github.com/ZHYX91/docwen-openclaw/releases)下载对应版本的 `openclaw-docwen-X.Y.Z.tgz`，然后在运行 Gateway 的电脑上安装：

   ```sh
   openclaw plugins install ./openclaw-docwen-X.Y.Z.tgz
   ```

3. **设置 DocWen 的位置。** 先使用只读配置示例 [`openclaw-config.example.json5`](../../openclaw-config.example.json5)，将 `plugins.entries.docwen.config.binaryPath` 替换为**运行 Gateway 的电脑**上 DocWenCLI 的实际绝对路径；Linux 上请选择已安装的可执行文件。示例允许使用以下工具：

   ```json5
   tools: {
     allow: ["docwen_info", "docwen_inspect", "docwen_resources", "docwen_validate_markdown"],
   }
   ```

   以后需要转换文件时，将对应的写入工具（例如 `"docwen_convert"`）加入列表。允许 `"docwen"` 会启用整个工具组，包括所有写入工具。

4. **先检查连接，不改动文件。** 请 OpenClaw 运行 `docwen_info`，确认 DocWen 已就绪。然后可以用 `docwen_inspect` 检查文件，用 `docwen_resources` 查找格式或模板，或用 `docwen_validate_markdown` 检查 Markdown。需要转换文件时，再启用对应工具并选择输出文件夹。

转换工具需要输入文件的完整路径，以及 Gateway 电脑上的输出文件夹。请选择一个新文件夹：设置 `overwrite=true` 会替换已有输出文件夹及其全部内容。只有明确指定 `inPlace=true` 时，Markdown 编号工具才会修改原文件。写入结果无法确认时，插件不会自动重试。常见操作见[用法示例（中文）](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/examples/basic.md)，设置说明见[配置参考（英文）](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/technical-details.md#configuration)。

在 Linux 上，如果插件提示输出文件系统不受支持，请改用 Linux 原生文件系统中的文件夹。WSL 挂载的 Windows 盘可能出现这种情况。

## 工作方式

OpenClaw 调用本机的 DocWen 可执行文件。检查文件不会改动原文件；转换或合并文件需要单独启用写入工具，并选择输出文件夹。插件会在保存前验证结果；无法确认写入是否成功时，不会自动重试。

路径必须指向**运行 Gateway 的电脑**上的文件，不能使用另一台连接 OpenClaw 的设备上的路径。具体输入规则、取消处理和恢复状态，见[技术与安全说明（英文）](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/technical-details.md)。

## 工具

| 工具                          | 作用                           | 权限       |
| ----------------------------- | ------------------------------ | ---------- |
| `docwen_info`                 | 检查 DocWen 安装情况和可用功能 | 只读       |
| `docwen_inspect`              | 识别文件格式和可用操作         | 只读       |
| `docwen_resources`            | 浏览格式、模板和编号方案       | 只读       |
| `docwen_validate_markdown`    | 检查 Markdown 并列出问题       | 只读       |
| `docwen_convert`              | 将文件转换为指定格式           | 需单独启用 |
| `docwen_number_markdown`      | 添加或删除 Markdown 标题编号   | 需单独启用 |
| `docwen_merge_pdfs`           | 按指定顺序合并 PDF             | 需单独启用 |
| `docwen_split_pdf`            | 提取选定的 PDF 页面            | 需单独启用 |
| `docwen_merge_tables`         | 合并电子表格                   | 需单独启用 |
| `docwen_merge_images_to_tiff` | 将图片合并为一个 TIFF 文件     | 需单独启用 |

可用的转换功能取决于你安装的 DocWen。插件会在开始任务前检查 DocWen 提供的功能。输入字段和写入保护措施，见[技术说明（英文）](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/technical-details.md)。

## 本地开发

```bash
npm ci
npm run check
npx openclaw plugins validate --root . --entry ./dist/index.js
```

按照 `openclaw-config.example.json5` 中的结构填写配置。测试覆盖范围和使用打包版 DocWen 进行验证的方法，见[测试与安装包验证（英文）](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/technical-details.md#testing-and-package-acceptance)。

## 版本发布

从 [GitHub Releases 页面](https://github.com/ZHYX91/docwen-openclaw/releases)下载并安装插件。构建、测试、校验和发布流程，见[维护者发布指南（英文）](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/releasing.md)。安装插件不会安装或升级 DocWen。

源码结构见[技术说明（英文）](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/technical-details.md)。
