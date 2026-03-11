---
name: docwen
description: 用 DocWen 在本机进行文档转换/校对/PDF 处理（通过 OpenClaw docwen 插件提供工具）
metadata: {"openclaw":{"requires":{"config":["plugins.entries.docwen.enabled"]}}}
---

## 你能做什么

- 把 Word/Excel/PDF/图片等转换为 Markdown，或把 Markdown 转为 DOCX/XLSX
- 校对文档（错别字/标点/敏感词等）
- 合并/拆分 PDF（含 OFD/XPS 等版式文件）
- 汇总多个表格
- 检查文件类型与可用操作

这些能力由 OpenClaw 插件注册为结构化工具：`docwen_*`。你只需要按参数调用工具，不要直接拼接 shell 命令。

## 使用前检查

1. 确认已安装并启用 OpenClaw 插件（id: `docwen`）。
2. 首次使用建议先运行一次自检：
   - 调用 `docwen_doctor`
3. 如企业网络禁止自动下载二进制，在 OpenClaw 配置中设置：
   - `plugins.entries.docwen.config.binaryPath` 指向 `DocWenCLI` 可执行文件
   - 或设置 `allowDownload=false` 并提供本地路径

## 工具速查

- `docwen_inspect(file)`：先判断文件类型与可用操作
- `docwen_formats(for?)`：列出可用目标格式
- `docwen_actions()`：列出可用动作
- `docwen_numbering_schemes()`：列出可用序号方案
- `docwen_convert(files, to, template?, extract_img?, ocr?, optimize_for?, clean_numbering?, add_numbering?, batch?, jobs?, continue_on_error?, yes?)`
- `docwen_validate(files, checks[])`
- `docwen_templates(for?)`：列出模板（docx/xlsx）
- `docwen_optimizations(scope?)`：列出可用优化类型
- `docwen_merge_pdfs(files[])`
- `docwen_split_pdf(file, pages, dpi?)`
- `docwen_merge_tables(files[], mode, base_table?)`
- `docwen_merge_images_to_tiff(files[], keep_alpha?, compress?, size_limit?, quality_mode?)`
- `docwen_md_numbering(files[], clean_numbering?, add_numbering?)`
- `docwen_doctor()`

## 推荐工作流

### Word 转 Markdown（可选提取图片/OCR）

1. `docwen_inspect` 识别文件
2. 询问用户是否需要提取图片与 OCR（不确定就问）
3. `docwen_convert`，`to="md"`，并按需设置 `extract_img`、`ocr`

### Markdown 转 Word（需要模板）

1. 先 `docwen_templates(for="docx")` 获取可用模板列表
2. 让用户选择模板（不确定就问）
3. `docwen_convert`，`to="docx"`，并提供 `template`

### PDF 合并/拆分

- 合并：`docwen_merge_pdfs(files)`
- 拆分：`docwen_split_pdf(file, pages)`，pages 示例：`"1-3,5,7-10"`

### Markdown 序号处理（清理/补全多级列表序号）

1. 先确认用户目标：是“去掉序号”，还是“按某个方案补全序号”
2. 如需选择方案，先 `docwen_numbering_schemes()` 获取可用方案
3. 使用 `docwen_md_numbering`：
   - 仅清理：传 `clean_numbering="default"` 或 `"remove"`（按用户要求）
   - 清理后补全：同时传 `clean_numbering=...` 与 `add_numbering="<scheme-id>"`

## 路径与安全约束

- `file/files` 必须是 OpenClaw Gateway 所在机器上可访问的路径（优先使用绝对路径）。
- 不要在工具参数里包含隐私信息以外的内容；工具会读写用户文件，请先确认输入文件与输出目录是否符合用户预期。
- 默认不启用任何优化；只有当用户明确要求或确认后才传 `optimize_for`。
