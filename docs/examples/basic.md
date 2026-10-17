# 常见用法

下面的路径只是示例，请换成运行 OpenClaw Gateway 的电脑上的实际路径。先用 `docwen_info` 检查 DocWen 是否可用；转换前需要启用对应工具，并指定保存结果的文件夹。

## Word 转 Markdown，并保留图片

先调用 `docwen_inspect` 检查文件：

```json
{ "file": "C:\\Documents\\report.docx" }
```

再调用 `docwen_convert`。下面的参数将 Markdown 和图片一起保存到 `report-result` 文件夹，不修改原 Word 文件：

```json
{
  "inputs": [
    {
      "file": "C:\\Documents\\report.docx",
      "kind": "document",
      "role": "source",
      "logicalPath": "documents/report.docx"
    }
  ],
  "to": "md",
  "outputDir": "C:\\Documents\\report-result",
  "keepImages": true,
  "ocr": false
}
```

`outputDir` 是本次结果专用的文件夹。如果它已经存在，请换一个新文件夹；只有明确要替换该文件夹及其全部内容时，才使用 `overwrite: true`。

## Markdown 转 Word，并带上引用的图片

先检查 `docwen_info` 的能力列表中是否有可用的 `convert.markdown_source.to_docx`。如果当前 DocWen 没有这个能力，需要升级到提供该能力的版本。

假设 Markdown 中写着 `![图表](assets/chart.png)`，可以这样调用 `docwen_convert`：

```json
{
  "inputs": [
    {
      "file": "C:\\Notes\\report.md",
      "kind": "document",
      "role": "source",
      "logicalPath": "documents/report.md"
    },
    {
      "file": "C:\\Images\\chart.png",
      "kind": "resource",
      "role": "linked_resource",
      "logicalPath": "documents/assets/chart.png"
    }
  ],
  "to": "docx",
  "outputDir": "C:\\Documents\\word-result"
}
```

`file` 指向磁盘上的实际文件；`logicalPath` 用来对应文档里的相对链接。因此，图片的 `logicalPath` 要与 Markdown 中的 `assets/chart.png` 对得上，即使两个文件实际放在不同文件夹。每张引用的图片都需要单独列入 `inputs`；插件不会自动搜索相邻目录。

如果已有其他程序生成的解析文档 JSON 和编号计划 JSON，可以使用另一条 `convert.markdown.to_docx` 接口。它只接受一个 `neutral_document` 和一个 `numbering_export_plan`，不能与上面的 Markdown `source` 输入混用。普通 Markdown 文件使用前面的示例即可，详细字段见[技术参考](../technical-details.md#tool-write-behavior)。

## 找到结果

成功后，`output.preferred_artifact` 是建议先打开的文件，`output.artifacts` 列出本次保存的全部文件。Markdown 引用的图片也在结果文件夹中，移动结果时应一起保留。

如果返回 `status: "warning"` 且 `publication.state: "published"`，结果已经保存，按提示处理清理问题即可。如果返回 `unconfirmed`，先检查返回的恢复路径，不要直接重复转换或删除临时文件。
