# DocWen for OpenClaw

[English](https://github.com/ZHYX91/docwen-openclaw/blob/main/README.md) · [简体中文](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.zh-CN.md) · [繁體中文](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.zh-TW.md) · [Deutsch](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.de-DE.md) · [Français](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.fr-FR.md) · [Español](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.es-ES.md) · [Português](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.pt-BR.md) · [Русский](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.ru-RU.md) · [日本語](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.ja-JP.md) · [한국어](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.ko-KR.md) · [Tiếng Việt](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.vi-VN.md) · [العربية](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.ar.md)

OpenClaw から DocWen を使って、文書のチェック、ファイルの変換、PDF やスプレッドシートの処理を行えます。ファイルは OpenClaw Gateway が動作するコンピューター上に置いたまま、そのコンピューターにインストールされた DocWen でローカル処理します。

このプラグインを使う前に、**DocWen 0.12.0 以降**を別途インストールしてください。[プラグインをダウンロード](https://github.com/ZHYX91/docwen-openclaw/releases)。

**OpenClaw の必要バージョン：** Gateway／プラグイン API は `>=2026.7.1-2 <2027.0.0` です。インストール前に Gateway のバージョンを確認してください。ビルド SDK の固定バージョンと Gateway の実行バージョンを一致させる必要はありません。

## できること

- ファイル形式を調べ、変換できる形式を確認する。
- 元のファイルを変更せずに Markdown の問題をチェックする。
- 文書を変換する、PDF を結合・分割する、スプレッドシートや画像をまとめる。

ファイルに書き込むツールは、**初期状態では無効**です。OpenClaw に使用を許可するツールと、結果の保存先を自分で指定します。

## はじめに

1. **DocWen を別途インストールします。** Gateway が動作する Windows x64 または Ubuntu 24.04 x64 のコンピューターに、対応する [DocWen リリース](https://github.com/ZHYX91/docwen/releases)（0.12.0 以降）をインストールしてください。Windows では `DocWenCLI.exe`、Linux では `DocWenCLI` の絶対パスを確認します。このプラグインをインストールしても、DocWen は**インストールされません**。
2. **OpenClaw プラグインをインストールします。** [プラグインのリリースページ](https://github.com/ZHYX91/docwen-openclaw/releases)から該当する `openclaw-docwen-X.Y.Z.tgz` をダウンロードし、Gateway が動作するコンピューターでインストールします。

   ```sh
   openclaw plugins install ./openclaw-docwen-X.Y.Z.tgz
   ```

3. **DocWen の場所を指定します。** 読み取り専用ツールだけを許可した [`openclaw-config.example.json5`](../../openclaw-config.example.json5) を出発点にしてください。`plugins.entries.docwen.config.binaryPath` を、**自分の Gateway が動作するコンピューター**上の DocWenCLI の実際の絶対パスに置き換えます。Linux では、インストール済みの実行ファイルを指定してください。この設定例では、次のツールが許可されています。

   ```json5
   tools: {
     allow: ["docwen_info", "docwen_inspect", "docwen_resources", "docwen_validate_markdown"],
   }
   ```

   後から変換を許可する場合は、`"docwen_convert"` など、使いたい書き込みツールを個別にこのリストへ追加します。`"docwen"` を許可すると、すべての書き込みツールを含むグループ全体が有効になります。

4. **ファイルを変更せずに接続を確認します。** OpenClaw に `docwen_info` の実行を依頼し、DocWen が使える状態か確認してください。次に、`docwen_inspect` でファイルを調べる、`docwen_resources` で形式やテンプレートを探す、`docwen_validate_markdown` で Markdown をチェックするといった操作を試せます。ファイルを変換するときは、必要なツールを許可して出力フォルダーを選びます。

変換ツールには、Gateway が動作するコンピューター上の入力ファイルのフルパスと、出力フォルダーが必要です。新しいフォルダーを選んでください。`overwrite=true` を指定すると、既存の出力フォルダーを中身ごとすべて置き換えます。Markdown の見出し番号を変更する場合は、`inPlace=true` を明示的に指定すると元のファイルも更新できます。書き込みが成功したかどうか判断できない場合、プラグインは自動で再試行しません。よく使う操作は[使用例（中国語）](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/examples/basic.md)、設定項目は[設定リファレンス（英語）](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/technical-details.md#configuration)を参照してください。

Linux で出力先のファイルシステムが未対応と表示された場合は、Linux ネイティブのファイルシステム上にあるフォルダーを選んでください。Windows のドライブを WSL にマウントしている場合などに、この問題が起きることがあります。

**Markdown の画像：** Markdown → Word では、まず `docwen_info` で `convert.markdown_source.to_docx` が使えるか確認してください。Markdown を `source` 文書として、参照する画像をそれぞれ `linked_resource` として渡し、`logicalPath` を本文に書かれた画像パスと一致させます。実ファイルは Gateway のコンピューター上に必要で、隣接フォルダーは自動検索されません。`keepImages`、`ocr`、`ocrLanguage` は、選んだ機能が明示的に対応する場合だけ指定してください。

## 仕組み

OpenClaw はローカルの DocWen 実行ファイルを呼び出します。ファイルのチェックでは元のファイルを変更しません。変換や結合には、書き込みツールを個別に許可し、出力フォルダーを指定する必要があります。プラグインは結果を検証してから保存し、結果を確認できなかった書き込みを自動で繰り返すことはありません。

パスには、OpenClaw に接続している別の端末ではなく、**Gateway が動作するコンピューター**上のファイルを指定してください。入力値の詳しいルール、キャンセル時の動作、復旧時の状態については、[技術仕様と安全性の詳細（英語）](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/technical-details.md)を参照してください。

## ツール

| ツール                        | 機能                                            | 権限             |
| ----------------------------- | ----------------------------------------------- | ---------------- |
| `docwen_info`                 | DocWen のインストール状態と利用できる機能を確認 | 読み取り専用     |
| `docwen_inspect`              | ファイル形式と利用できる操作を確認              | 読み取り専用     |
| `docwen_resources`            | 形式、テンプレート、番号付け方式を参照          | 読み取り専用     |
| `docwen_validate_markdown`    | Markdown をチェックして問題を報告               | 読み取り専用     |
| `docwen_convert`              | ファイルを指定した形式に変換                    | 個別の許可が必要 |
| `docwen_number_markdown`      | Markdown の見出し番号を追加・削除               | 個別の許可が必要 |
| `docwen_merge_pdfs`           | 指定した順序で PDF を結合                       | 個別の許可が必要 |
| `docwen_split_pdf`            | PDF から選択したページを抽出                    | 個別の許可が必要 |
| `docwen_merge_tables`         | スプレッドシートを結合                          | 個別の許可が必要 |
| `docwen_merge_images_to_tiff` | 複数の画像を 1 つの TIFF に結合                 | 個別の許可が必要 |

利用できる変換は、インストールされている DocWen によって異なります。プラグインは、DocWen が提供する機能を確認してから処理を開始します。入力項目と書き込み時の安全対策については、[技術仕様（英語）](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/technical-details.md)を参照してください。

## ローカルでの開発

```bash
npm ci
npm run check
npx openclaw plugins validate --root . --entry ./dist/index.js
```

設定の構造は `openclaw-config.example.json5` を参考にしてください。テストの対象範囲と、配布パッケージ版 DocWen を使った検証については、[テストとパッケージ検証（英語）](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/technical-details.md#testing-and-package-acceptance)を参照してください。

## リリース

[GitHub Releases ページ](https://github.com/ZHYX91/docwen-openclaw/releases)からプラグインのリリースをインストールできます。リリースのビルド、テスト、検証、公開の手順は、[メンテナー向けリリースガイド（英語）](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/releasing.md)を参照してください。このプラグインのインストールによって DocWen がインストールまたは更新されることはありません。

ソースファイルの構成については、[技術仕様（英語）](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/technical-details.md)を参照してください。
