# DocWen for OpenClaw

[English](https://github.com/ZHYX91/docwen-openclaw/blob/main/README.md) · [简体中文](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.zh-CN.md) · [繁體中文](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.zh-TW.md) · [Deutsch](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.de-DE.md) · [Français](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.fr-FR.md) · [Español](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.es-ES.md) · [Português](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.pt-BR.md) · [Русский](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.ru-RU.md) · [日本語](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.ja-JP.md) · [한국어](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.ko-KR.md) · [Tiếng Việt](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.vi-VN.md) · [العربية](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.ar.md)

Bạn có thể dùng DocWen từ OpenClaw để kiểm tra tài liệu, chuyển đổi tệp, xử lý PDF và bảng tính. Các tệp vẫn nằm trên máy tính chạy OpenClaw Gateway. Plugin dùng bản DocWen đã cài trên máy tính đó để xử lý tệp ngay tại máy.

Trước khi sử dụng plugin này, hãy cài riêng **DocWen 0.12.0 trở lên**. [Tải plugin](https://github.com/ZHYX91/docwen-openclaw/releases).

**Yêu cầu phiên bản OpenClaw:** Gateway và API plugin phải thuộc `>=2026.7.1-2 <2027.0.0`. Hãy kiểm tra phiên bản Gateway trước khi cài; phiên bản SDK cố định lúc xây dựng không yêu cầu chạy đúng phiên bản Gateway đó.

## Bạn có thể làm gì?

- Kiểm tra định dạng của tệp và xem có thể chuyển đổi sang những định dạng nào.
- Kiểm tra lỗi trong Markdown mà không sửa tệp gốc.
- Chuyển đổi tài liệu, gộp hoặc tách PDF, gộp bảng tính hoặc hình ảnh.

Các công cụ ghi hoặc thay đổi tệp **mặc định bị tắt**. Bạn tự chọn những công cụ OpenClaw được phép dùng và nơi lưu kết quả.

## Bắt đầu nhanh

1. **Cài DocWen riêng.** Trên máy tính Windows x64 hoặc Ubuntu 24.04 x64 đang chạy Gateway, hãy cài một [bản phát hành DocWen](https://github.com/ZHYX91/docwen/releases) tương thích (0.12.0 trở lên). Xác định đường dẫn tuyệt đối đầy đủ đến `DocWenCLI.exe` trên Windows hoặc `DocWenCLI` trên Linux. DocWen **không được cài kèm** plugin này.
2. **Cài plugin OpenClaw.** Tải tệp `openclaw-docwen-X.Y.Z.tgz` tương ứng từ [trang phát hành của plugin](https://github.com/ZHYX91/docwen-openclaw/releases) rồi cài trên máy tính chạy Gateway:

   ```sh
   openclaw plugins install ./openclaw-docwen-X.Y.Z.tgz
   ```

3. **Chỉ cho plugin biết vị trí DocWen.** Bắt đầu với [`openclaw-config.example.json5`](../../openclaw-config.example.json5), mẫu cấu hình chỉ cho phép các công cụ đọc. Thay `plugins.entries.docwen.config.binaryPath` bằng đường dẫn tuyệt đối thực tế đến DocWenCLI trên **máy tính chạy Gateway của bạn**; trên Linux, hãy trỏ đến tệp thực thi đã cài. Danh sách công cụ được phép dùng trong mẫu là:

   ```json5
   tools: {
     allow: ["docwen_info", "docwen_inspect", "docwen_resources", "docwen_validate_markdown"],
   }
   ```

   Khi muốn cho phép chuyển đổi, hãy thêm riêng công cụ ghi cần dùng, chẳng hạn `"docwen_convert"`, vào danh sách đó. Cho phép `"docwen"` sẽ bật cả nhóm, bao gồm mọi công cụ ghi.

4. **Kiểm tra kết nối mà không thay đổi tệp.** Yêu cầu OpenClaw chạy `docwen_info` để kiểm tra DocWen đã sẵn sàng chưa. Sau đó dùng `docwen_inspect` để kiểm tra một tệp, `docwen_resources` để tìm định dạng hoặc mẫu, hoặc `docwen_validate_markdown` để kiểm tra Markdown. Khi cần chuyển đổi tệp, hãy cho phép công cụ tương ứng và chọn thư mục đầu ra.

Các công cụ chuyển đổi cần đường dẫn đầy đủ đến tệp đầu vào và một thư mục đầu ra trên máy tính chạy Gateway. Hãy chọn thư mục mới: `overwrite=true` thay thế toàn bộ thư mục đầu ra hiện có cùng mọi nội dung bên trong. Công cụ đánh số tiêu đề Markdown cũng có thể cập nhật tệp gốc khi bạn yêu cầu rõ ràng bằng `inPlace=true`. Nếu chưa thể xác định thao tác ghi đã thành công hay chưa, plugin sẽ không tự động thử lại. Xem [các ví dụ (tiếng Trung)](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/examples/basic.md) để biết cách thực hiện những tác vụ thường gặp và [tài liệu cấu hình (tiếng Anh)](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/technical-details.md#configuration) để biết các thiết lập.

Trên Linux, nếu plugin báo không hỗ trợ hệ thống tệp ở nơi lưu kết quả, hãy chọn một thư mục trên hệ thống tệp của Linux. Lỗi này có thể xảy ra với các ổ đĩa Windows được gắn vào WSL.

**Ảnh trong Markdown:** trước khi chuyển Markdown sang Word, dùng `docwen_info` kiểm tra có `convert.markdown_source.to_docx`. Cung cấp Markdown dưới dạng tài liệu `source`, còn mỗi ảnh được tham chiếu là một `linked_resource` riêng; `logicalPath` phải khớp đường dẫn viết trong Markdown. Tệp thật phải nằm trên máy Gateway; plugin không tự tìm ảnh trong thư mục lân cận. Chỉ thêm `keepImages`, `ocr` hoặc `ocrLanguage` nếu khả năng đã chọn thật sự hỗ trợ các tùy chọn đó.

## Cách hoạt động

OpenClaw gọi tệp thực thi DocWen trên máy. Việc kiểm tra tệp không làm thay đổi tệp đó; muốn chuyển đổi hoặc gộp tệp, bạn cần cho phép riêng công cụ ghi và chọn thư mục đầu ra. Plugin kiểm tra kết quả trước khi lưu và không tự động lặp lại thao tác ghi khi chưa rõ kết quả.

Đường dẫn phải trỏ đến tệp trên **máy tính chạy Gateway**, không phải một thiết bị khác đang kết nối với OpenClaw. Xem [chi tiết kỹ thuật và an toàn (tiếng Anh)](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/technical-details.md) để biết chính xác các quy tắc đầu vào, cách xử lý khi hủy và các trạng thái khôi phục.

## Công cụ

| Công cụ                       | Chức năng                                               | Quyền              |
| ----------------------------- | ------------------------------------------------------- | ------------------ |
| `docwen_info`                 | Kiểm tra bản cài DocWen và các tính năng có thể dùng    | Chỉ đọc            |
| `docwen_inspect`              | Xác định định dạng tệp và các thao tác có thể thực hiện | Chỉ đọc            |
| `docwen_resources`            | Tra cứu định dạng, mẫu và kiểu đánh số                  | Chỉ đọc            |
| `docwen_validate_markdown`    | Kiểm tra Markdown và báo các vấn đề                     | Chỉ đọc            |
| `docwen_convert`              | Chuyển đổi tệp sang định dạng đã chọn                   | Cần cho phép riêng |
| `docwen_number_markdown`      | Thêm hoặc xóa số thứ tự của tiêu đề Markdown            | Cần cho phép riêng |
| `docwen_merge_pdfs`           | Gộp các tệp PDF theo thứ tự được chỉ định               | Cần cho phép riêng |
| `docwen_split_pdf`            | Trích xuất các trang PDF đã chọn                        | Cần cho phép riêng |
| `docwen_merge_tables`         | Gộp bảng tính                                           | Cần cho phép riêng |
| `docwen_merge_images_to_tiff` | Gộp hình ảnh thành một tệp TIFF                         | Cần cho phép riêng |

Các phép chuyển đổi có thể dùng phụ thuộc vào bản DocWen đã cài. Plugin kiểm tra những tính năng mà bản cài đó cung cấp trước khi bắt đầu tác vụ. Xem [chi tiết kỹ thuật (tiếng Anh)](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/technical-details.md) để biết các trường đầu vào và biện pháp bảo vệ khi ghi.

## Phát triển cục bộ

```bash
npm ci
npm run check
npx openclaw plugins validate --root . --entry ./dist/index.js
```

Dùng `openclaw-config.example.json5` làm mẫu cho cấu trúc cấu hình. Xem [kiểm thử và kiểm tra gói phát hành (tiếng Anh)](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/technical-details.md#testing-and-package-acceptance) để biết phạm vi kiểm thử và các bước kiểm tra với gói phát hành DocWen.

## Bản phát hành

Cài bản phát hành của plugin từ [trang GitHub Releases](https://github.com/ZHYX91/docwen-openclaw/releases). Để biết cách xây dựng, kiểm thử, xác minh và phát hành một phiên bản, hãy xem [hướng dẫn phát hành dành cho người bảo trì (tiếng Anh)](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/releasing.md). Việc cài plugin này không cài đặt hoặc nâng cấp DocWen.

Xem [chi tiết kỹ thuật (tiếng Anh)](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/technical-details.md) để biết cách tổ chức các tệp mã nguồn.
