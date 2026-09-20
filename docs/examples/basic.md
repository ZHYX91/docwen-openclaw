用户：帮我把这个 Word 转成 Markdown，并把图片也提取出来

助手：

1. 先检查文件类型

   调用：`docwen_inspect(file="C:\\path\\to\\report.docx")`

2. 执行转换（保留图片，不启用 OCR），明确授权一个完整 Bundle 目录

   调用：`docwen_convert(inputs=[{file="C:\\physical\\report.docx", kind="document", role="source", logicalPath="documents/report.docx"}], to="md", outputDir="C:\\path\\to\\report-bundle", keepImages=true, ocr=false)`

   若 Markdown 源文档引用图片，图片也要作为独立 input 明示，例如 `{file="C:\\physical-assets\\chart.png", kind="resource", role="linked_resource", logicalPath="documents/assets/chart.png"}`。不得根据 Word 或 Markdown 的物理相邻目录猜测资源。

   Markdown 转 DOCX 使用解析后的精确两输入合同，不接受上面的普通 `source` 形式：一个 `{kind="document", role="neutral_document"}` JSON 和一个 `{kind="resource", role="numbering_export_plan"}` JSON，二者都必须有独立的 `logicalPath`，且不得再附加 `linked_resource`、书目或引用样式输入。

3. 从 Machine v2 结果中报告 `preferred_artifact` 和全部 `artifacts`。产物关系与完整性信息保留在结构化结果中；输出目录只包含实际文档和资源。
