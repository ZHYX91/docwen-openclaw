# DocWen for OpenClaw

[English](https://github.com/ZHYX91/docwen-openclaw/blob/main/README.md) · [简体中文](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.zh-CN.md) · [繁體中文](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.zh-TW.md) · [Deutsch](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.de-DE.md) · [Français](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.fr-FR.md) · [Español](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.es-ES.md) · [Português](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.pt-BR.md) · [Русский](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.ru-RU.md) · [日本語](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.ja-JP.md) · [한국어](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.ko-KR.md) · [Tiếng Việt](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.vi-VN.md) · [العربية](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.ar.md)

在 OpenClaw 中使用 DocWen 檢查文件、轉換檔案，並處理 PDF 和試算表。檔案留在執行 OpenClaw Gateway 的電腦上，由這台電腦安裝的 DocWen 在本機處理。

使用此外掛前，請先另外安裝 **DocWen 0.12.0 或更新版本**。[下載外掛](https://github.com/ZHYX91/docwen-openclaw/releases)。

**OpenClaw 版本要求：** Gateway／外掛 API 須符合 `>=2026.7.1-2 <2027.0.0`。安裝前請確認 Gateway 版本；建置時固定的 SDK 版本不表示必須執行相同版本的 Gateway。

## 可以做什麼

- 查看檔案格式和可用的轉換方式。
- 檢查 Markdown 中的問題，不更動原始檔案。
- 轉換文件、合併或分割 PDF，以及合併試算表或圖片。

會寫入或修改檔案的工具**預設停用**。由你決定 OpenClaw 可以使用哪些工具，以及結果儲存在哪裡。

## 快速開始

1. **另外安裝 DocWen。** 在執行 Gateway 的 Windows x64 或 Ubuntu 24.04 x64 電腦上，安裝相容的 [DocWen 版本](https://github.com/ZHYX91/docwen/releases)（0.12.0 或更新版本）。找到 Windows 上 `DocWenCLI.exe` 或 Linux 上 `DocWenCLI` 的完整絕對路徑。安裝此外掛**不會同時安裝 DocWen**。
2. **安裝 OpenClaw 外掛。** 從[外掛發布頁面](https://github.com/ZHYX91/docwen-openclaw/releases)下載對應版本的 `openclaw-docwen-X.Y.Z.tgz`，然後在執行 Gateway 的電腦上安裝：

   ```sh
   openclaw plugins install ./openclaw-docwen-X.Y.Z.tgz
   ```

3. **設定 DocWen 的位置。** 先使用唯讀設定範例 [`openclaw-config.example.json5`](../../openclaw-config.example.json5)，將 `plugins.entries.docwen.config.binaryPath` 替換為**執行 Gateway 的電腦**上 DocWenCLI 的實際絕對路徑；Linux 上請選擇已安裝的執行檔。範例允許使用以下工具：

   ```json5
   tools: {
     allow: ["docwen_info", "docwen_inspect", "docwen_resources", "docwen_validate_markdown"],
   }
   ```

   日後需要轉換檔案時，將對應的寫入工具（例如 `"docwen_convert"`）加入清單。允許 `"docwen"` 會啟用整個工具群組，包括所有寫入工具。

4. **先檢查連線，不更動檔案。** 請 OpenClaw 執行 `docwen_info`，確認 DocWen 已就緒。接著可以用 `docwen_inspect` 檢查檔案，用 `docwen_resources` 尋找格式或範本，或用 `docwen_validate_markdown` 檢查 Markdown。需要轉換檔案時，再啟用對應工具並選擇輸出資料夾。

轉換工具需要輸入檔案的完整路徑，以及 Gateway 電腦上的輸出資料夾。請選擇新的資料夾：設定 `overwrite=true` 會取代既有輸出資料夾及其全部內容。只有明確指定 `inPlace=true` 時，Markdown 編號工具才會修改原始檔案。無法確認寫入結果時，外掛不會自動重試。常見操作請見[使用範例（簡體中文）](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/examples/basic.md)，設定說明請見[設定參考（英文）](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/technical-details.md#configuration)。

在 Linux 上，如果外掛提示輸出檔案系統不受支援，請改用 Linux 原生檔案系統中的資料夾。WSL 掛載的 Windows 磁碟可能出現這種情況。

**Markdown 裡的圖片：** 將 Markdown 轉成 Word 前，先用 `docwen_info` 確認有 `convert.markdown_source.to_docx` 功能。將 Markdown 當成 `source` 文件，每張引用圖片分別以 `linked_resource` 提供，並讓 `logicalPath` 與原文中的圖片路徑對應。實體檔案必須位於 Gateway 電腦；外掛不會自動搜尋相鄰圖片。只有所選功能明確支援時才加入 `keepImages`、`ocr` 或 `ocrLanguage`，不要為一般圖片嵌入自行加上這些選項。

## 運作方式

OpenClaw 呼叫本機的 DocWen 執行檔。檢查檔案不會更動原始檔案；轉換或合併檔案需要另外啟用寫入工具，並選擇輸出資料夾。外掛會在儲存前驗證結果；無法確認寫入是否成功時，不會自動重試。

路徑必須指向**執行 Gateway 的電腦**上的檔案，不能使用另一台連線至 OpenClaw 的裝置上的路徑。詳細的輸入規則、取消處理和復原狀態，請見[技術與安全說明（英文）](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/technical-details.md)。

## 工具

| 工具                          | 用途                           | 權限       |
| ----------------------------- | ------------------------------ | ---------- |
| `docwen_info`                 | 檢查 DocWen 安裝情況和可用功能 | 唯讀       |
| `docwen_inspect`              | 辨識檔案格式和可用操作         | 唯讀       |
| `docwen_resources`            | 瀏覽格式、範本和編號方案       | 唯讀       |
| `docwen_validate_markdown`    | 檢查 Markdown 並列出問題       | 唯讀       |
| `docwen_convert`              | 將檔案轉換為指定格式           | 需另外啟用 |
| `docwen_number_markdown`      | 加入或移除 Markdown 標題編號   | 需另外啟用 |
| `docwen_merge_pdfs`           | 依指定順序合併 PDF             | 需另外啟用 |
| `docwen_split_pdf`            | 擷取選定的 PDF 頁面            | 需另外啟用 |
| `docwen_merge_tables`         | 合併試算表                     | 需另外啟用 |
| `docwen_merge_images_to_tiff` | 將圖片合併為一個 TIFF 檔案     | 需另外啟用 |

可用的轉換功能取決於你安裝的 DocWen。外掛會在開始工作前檢查 DocWen 提供的功能。輸入欄位和寫入保護措施，請見[技術說明（英文）](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/technical-details.md)。

## 本機開發

```bash
npm ci
npm run check
npx openclaw plugins validate --root . --entry ./dist/index.js
```

請依照 `openclaw-config.example.json5` 中的結構填寫設定。測試涵蓋範圍和使用 DocWen 安裝套件進行驗證的方法，請見[測試與安裝套件驗證（英文）](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/technical-details.md#testing-and-package-acceptance)。

## 版本發布

從 [GitHub Releases 頁面](https://github.com/ZHYX91/docwen-openclaw/releases)下載並安裝外掛。建置、測試、驗證和發布流程，請見[維護者發布指南（英文）](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/releasing.md)。安裝外掛不會安裝或更新 DocWen。

原始碼結構請見[技術說明（英文）](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/technical-details.md)。
