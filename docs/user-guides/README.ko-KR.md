# DocWen for OpenClaw

[English](https://github.com/ZHYX91/docwen-openclaw/blob/main/README.md) · [简体中文](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.zh-CN.md) · [繁體中文](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.zh-TW.md) · [Deutsch](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.de-DE.md) · [Français](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.fr-FR.md) · [Español](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.es-ES.md) · [Português](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.pt-BR.md) · [Русский](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.ru-RU.md) · [日本語](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.ja-JP.md) · [한국어](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.ko-KR.md) · [Tiếng Việt](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.vi-VN.md) · [العربية](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.ar.md)

OpenClaw에서 DocWen으로 문서를 검사하고 파일을 변환하며 PDF와 스프레드시트를 처리할 수 있습니다. 파일은 OpenClaw Gateway가 실행되는 컴퓨터에 그대로 두고, 같은 컴퓨터에 설치된 DocWen으로 로컬에서 처리합니다.

이 플러그인을 사용하려면 **DocWen 0.12.0 이상**을 별도로 설치하세요. [플러그인 다운로드](https://github.com/ZHYX91/docwen-openclaw/releases).

**OpenClaw 버전 요구 사항:** Gateway 및 플러그인 API는 `>=2026.7.1-2 <2027.0.0` 범위여야 합니다. 설치 전에 Gateway 버전을 확인하세요. 빌드 SDK의 고정 버전과 실행 중인 Gateway 버전을 똑같이 맞출 필요는 없습니다.

## 할 수 있는 일

- 파일 형식과 변환 가능한 형식을 확인합니다.
- 원본을 수정하지 않고 Markdown의 문제를 검사합니다.
- 문서를 변환하고, PDF를 병합하거나 분할하고, 스프레드시트나 이미지를 합칩니다.

파일을 만들거나 변경하는 도구는 **기본적으로 꺼져 있습니다**. OpenClaw에서 사용할 도구와 결과를 저장할 위치는 직접 지정합니다.

## 빠른 시작

1. **DocWen을 별도로 설치하세요.** Gateway가 실행되는 Windows x64 또는 Ubuntu 24.04 x64 컴퓨터에 호환되는 [DocWen 릴리스](https://github.com/ZHYX91/docwen/releases)(0.12.0 이상)를 설치합니다. Windows에서는 `DocWenCLI.exe`, Linux에서는 `DocWenCLI`의 전체 절대 경로를 확인하세요. 이 플러그인을 설치해도 DocWen이 **함께 설치되지는 않습니다**.
2. **OpenClaw 플러그인을 설치하세요.** [플러그인 릴리스 페이지](https://github.com/ZHYX91/docwen-openclaw/releases)에서 필요한 `openclaw-docwen-X.Y.Z.tgz` 파일을 내려받고, Gateway가 실행되는 컴퓨터에 설치합니다.

   ```sh
   openclaw plugins install ./openclaw-docwen-X.Y.Z.tgz
   ```

3. **플러그인에 DocWen 경로를 지정하세요.** 읽기 전용 도구만 허용한 [`openclaw-config.example.json5`](../../openclaw-config.example.json5)를 시작점으로 사용하세요. `plugins.entries.docwen.config.binaryPath`를 **내 Gateway가 실행되는 컴퓨터**의 실제 DocWenCLI 절대 경로로 바꿉니다. Linux에서는 설치된 실행 파일을 지정하세요. 이 설정 예제에서 허용하는 도구는 다음과 같습니다.

   ```json5
   tools: {
     allow: ["docwen_info", "docwen_inspect", "docwen_resources", "docwen_validate_markdown"],
   }
   ```

   나중에 변환을 허용하려면 `"docwen_convert"`처럼 사용할 쓰기 도구를 이 목록에 개별적으로 추가하세요. `"docwen"`을 허용하면 모든 쓰기 도구를 포함한 전체 그룹이 활성화됩니다.

4. **파일을 변경하지 않고 연결을 확인하세요.** OpenClaw에 `docwen_info`를 실행하도록 요청해 DocWen이 준비되었는지 확인합니다. 그런 다음 `docwen_inspect`로 파일을 검사하거나, `docwen_resources`로 형식이나 템플릿을 찾거나, `docwen_validate_markdown`으로 Markdown을 검사할 수 있습니다. 파일을 변환할 때는 해당 도구를 허용하고 출력 폴더를 선택하세요.

변환 도구에는 Gateway 컴퓨터에 있는 입력 파일의 전체 경로와 출력 폴더가 필요합니다. 새 폴더를 선택하세요. `overwrite=true`는 기존 출력 폴더 전체와 그 안의 모든 내용을 교체합니다. Markdown 제목 번호를 변경할 때 `inPlace=true`를 명시적으로 요청하면 원본 파일을 직접 업데이트할 수도 있습니다. 쓰기 결과를 확실히 알 수 없으면 플러그인은 자동으로 다시 시도하지 않습니다. 자주 사용하는 작업은 [사용 예제(중국어)](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/examples/basic.md)를, 설정 항목은 [설정 참고 문서(영어)](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/technical-details.md#configuration)를 확인하세요.

Linux에서 출력 파일시스템을 지원하지 않는다는 메시지가 나오면 Linux 자체 파일시스템에 있는 폴더를 선택하세요. Windows 드라이브를 WSL에 마운트한 경우 이런 문제가 발생할 수 있습니다.

**Markdown 이미지:** Markdown을 Word로 변환하기 전에 `docwen_info`로 `convert.markdown_source.to_docx` 지원 여부를 확인하세요. Markdown은 `source` 문서로, 각 참조 이미지는 별도의 `linked_resource`로 제공하고 `logicalPath`는 Markdown에 적힌 이미지 경로와 맞춰야 합니다. 실제 파일은 Gateway 컴퓨터에 있어야 하며 플러그인은 옆 폴더를 자동 검색하지 않습니다. `keepImages`, `ocr`, `ocrLanguage`는 선택한 기능에서 해당 옵션을 명시적으로 제공할 때만 지정하세요.

## 작동 방식

OpenClaw는 로컬 DocWen 실행 파일을 호출합니다. 파일을 검사할 때는 원본이 바뀌지 않습니다. 파일을 변환하거나 합치려면 쓰기 도구를 별도로 허용하고 출력 폴더를 직접 선택해야 합니다. 플러그인은 결과를 검증한 뒤 저장하며, 결과가 불확실한 쓰기를 자동으로 반복하지 않습니다.

경로는 OpenClaw에 연결된 다른 기기가 아니라 **Gateway 컴퓨터**의 파일을 가리켜야 합니다. 정확한 입력 규칙, 취소 시 동작, 복구 상태는 [기술 및 안전 세부 사항(영어)](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/technical-details.md)을 확인하세요.

## 도구

| 도구                          | 기능                                     | 권한           |
| ----------------------------- | ---------------------------------------- | -------------- |
| `docwen_info`                 | DocWen 설치 상태와 사용 가능한 기능 확인 | 읽기 전용      |
| `docwen_inspect`              | 파일 형식과 가능한 작업 확인             | 읽기 전용      |
| `docwen_resources`            | 형식, 템플릿, 번호 매기기 방식 조회      | 읽기 전용      |
| `docwen_validate_markdown`    | Markdown을 검사하고 문제 보고            | 읽기 전용      |
| `docwen_convert`              | 파일을 선택한 형식으로 변환              | 개별 허용 필요 |
| `docwen_number_markdown`      | Markdown 제목 번호 추가 또는 제거        | 개별 허용 필요 |
| `docwen_merge_pdfs`           | 지정한 순서대로 PDF 병합                 | 개별 허용 필요 |
| `docwen_split_pdf`            | PDF에서 선택한 페이지 추출               | 개별 허용 필요 |
| `docwen_merge_tables`         | 스프레드시트 합치기                      | 개별 허용 필요 |
| `docwen_merge_images_to_tiff` | 여러 이미지를 하나의 TIFF로 합치기       | 개별 허용 필요 |

사용 가능한 변환은 설치된 DocWen에 따라 달라집니다. 플러그인은 작업을 시작하기 전에 DocWen이 제공하는 기능을 확인합니다. 입력 항목과 쓰기 작업의 보호 장치는 [기술 세부 사항(영어)](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/technical-details.md)을 확인하세요.

## 로컬 개발

```bash
npm ci
npm run check
npx openclaw plugins validate --root . --entry ./dist/index.js
```

설정 구조는 `openclaw-config.example.json5`를 참고하세요. 테스트 범위와 배포 패키지로 설치한 DocWen을 대상으로 한 검증은 [테스트 및 패키지 검증(영어)](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/technical-details.md#testing-and-package-acceptance)을 확인하세요.

## 릴리스

[GitHub Releases 페이지](https://github.com/ZHYX91/docwen-openclaw/releases)에서 플러그인 릴리스를 설치하세요. 릴리스 빌드, 테스트, 검증, 배포 절차는 [유지보수자용 릴리스 가이드(영어)](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/releasing.md)에 나와 있습니다. 이 플러그인을 설치해도 DocWen이 설치되거나 업그레이드되지는 않습니다.

소스 파일의 구성은 [기술 세부 사항(영어)](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/technical-details.md)을 확인하세요.
