# DocWen for OpenClaw

[English](https://github.com/ZHYX91/docwen-openclaw/blob/main/README.md) · [简体中文](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.zh-CN.md) · [繁體中文](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.zh-TW.md) · [Deutsch](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.de-DE.md) · [Français](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.fr-FR.md) · [Español](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.es-ES.md) · [Português](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.pt-BR.md) · [Русский](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.ru-RU.md) · [日本語](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.ja-JP.md) · [한국어](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.ko-KR.md) · [Tiếng Việt](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.vi-VN.md) · [العربية](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.ar.md)

Работайте с DocWen из OpenClaw: проверяйте документы, конвертируйте файлы и обрабатывайте PDF и электронные таблицы. Файлы остаются на компьютере, где работает ваш OpenClaw Gateway. Плагин обрабатывает их локально с помощью DocWen, установленного на этом компьютере.

Перед использованием плагина отдельно установите **DocWen 0.12.0 или новее**. [Скачать плагин](https://github.com/ZHYX91/docwen-openclaw/releases).

## Что можно делать

- Определять формат файла и узнавать, в какие форматы его можно преобразовать.
- Проверять Markdown на ошибки, не изменяя исходный файл.
- Конвертировать документы, объединять и разделять PDF, объединять электронные таблицы или изображения.

Инструменты, которые записывают или изменяют файлы, **по умолчанию отключены**. Вы сами выбираете, какие из них разрешить OpenClaw и куда сохранять результаты.

## Быстрый старт

1. **Отдельно установите DocWen.** На компьютере с Windows x64 или Ubuntu 24.04 x64, где работает ваш Gateway, установите совместимый [выпуск DocWen](https://github.com/ZHYX91/docwen/releases) (0.12.0 или новее). Найдите полный абсолютный путь к `DocWenCLI.exe` в Windows или `DocWenCLI` в Linux. Установка этого плагина **не устанавливает** DocWen.
2. **Установите плагин OpenClaw.** Скачайте нужный пакет `openclaw-docwen-X.Y.Z.tgz` со [страницы выпусков плагина](https://github.com/ZHYX91/docwen-openclaw/releases) и установите его на компьютере с Gateway:

   ```sh
   openclaw plugins install ./openclaw-docwen-X.Y.Z.tgz
   ```

3. **Укажите плагину путь к DocWen.** Начните с файла [`openclaw-config.example.json5`](../../openclaw-config.example.json5), в котором разрешены только инструменты чтения. Замените `plugins.entries.docwen.config.binaryPath` фактическим абсолютным путём к DocWenCLI **на вашем компьютере с Gateway**; в Linux укажите установленный исполняемый файл. В примере разрешены следующие инструменты:

   ```json5
   tools: {
     allow: ["docwen_info", "docwen_inspect", "docwen_resources", "docwen_validate_markdown"],
   }
   ```

   Чтобы позже разрешить конвертацию, добавьте в этот список конкретный инструмент записи, например `"docwen_convert"`. Разрешение `"docwen"` включает всю группу, в том числе все инструменты записи.

4. **Проверьте подключение без изменения файлов.** Попросите OpenClaw запустить `docwen_info`, чтобы проверить готовность DocWen. Затем используйте `docwen_inspect` для проверки файла, `docwen_resources` для поиска формата или шаблона либо `docwen_validate_markdown` для проверки Markdown. Когда понадобится конвертация, разрешите соответствующий инструмент и выберите папку для результата.

Инструментам конвертации нужны полные пути к исходным файлам и папка для результатов на компьютере с Gateway. Выберите новую папку: `overwrite=true` заменяет всю существующую папку результатов вместе со всем её содержимым. При работе с нумерацией Markdown можно также обновить исходный файл, если явно указать `inPlace=true`. Если результат записи неясен, плагин не будет автоматически повторять её. О распространённых задачах читайте в [примерах (на китайском)](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/examples/basic.md), а о настройках — в [справочнике по конфигурации (на английском)](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/technical-details.md#configuration).

Если в Linux плагин сообщает, что файловая система для сохранения результатов не поддерживается, выберите папку в собственной файловой системе Linux. Такая ошибка возможна, например, с дисками Windows, подключёнными в WSL.

## Как это работает

OpenClaw вызывает локальный исполняемый файл DocWen. Проверка файла не изменяет его. Для конвертации или объединения файлов нужно отдельно разрешить соответствующий инструмент записи и выбрать папку для результатов. Плагин проверяет результаты перед сохранением и не повторяет запись автоматически, если её результат неясен.

Пути должны указывать на файлы **на компьютере с Gateway**, а не на другом устройстве, подключённом к OpenClaw. Точные требования к входным данным, поведение при отмене и состояния восстановления описаны в [техническом описании и правилах безопасной работы (на английском)](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/technical-details.md).

## Инструменты

| Инструмент                    | Что делает                                         | Разрешение         |
| ----------------------------- | -------------------------------------------------- | ------------------ |
| `docwen_info`                 | Проверяет установку DocWen и доступные возможности | Только чтение      |
| `docwen_inspect`              | Определяет формат файла и доступные действия       | Только чтение      |
| `docwen_resources`            | Показывает форматы, шаблоны и схемы нумерации      | Только чтение      |
| `docwen_validate_markdown`    | Проверяет Markdown и сообщает о проблемах          | Только чтение      |
| `docwen_convert`              | Конвертирует файлы в выбранный формат              | Разрешить отдельно |
| `docwen_number_markdown`      | Добавляет или удаляет номера заголовков Markdown   | Разрешить отдельно |
| `docwen_merge_pdfs`           | Объединяет PDF в заданном порядке                  | Разрешить отдельно |
| `docwen_split_pdf`            | Извлекает выбранные страницы PDF                   | Разрешить отдельно |
| `docwen_merge_tables`         | Объединяет электронные таблицы                     | Разрешить отдельно |
| `docwen_merge_images_to_tiff` | Объединяет изображения в TIFF                      | Разрешить отдельно |

Доступные преобразования зависят от установленного у вас DocWen. Перед началом задачи плагин проверяет, какие возможности предоставляет эта установка. О полях ввода и защите при записи читайте в [техническом описании (на английском)](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/technical-details.md).

## Локальная разработка

```bash
npm ci
npm run check
npx openclaw plugins validate --root . --entry ./dist/index.js
```

Используйте `openclaw-config.example.json5` как образец структуры конфигурации. Об охвате тестами и проверках с готовым пакетом DocWen читайте в [разделе о тестировании и проверке пакета (на английском)](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/technical-details.md#testing-and-package-acceptance).

## Выпуски

Установите выпуск плагина со [страницы GitHub Releases](https://github.com/ZHYX91/docwen-openclaw/releases). Сборка, тестирование, проверка и публикация выпуска описаны в [руководстве по выпуску для сопровождающих (на английском)](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/releasing.md). Установка этого плагина никогда не устанавливает и не обновляет DocWen.

Обзор исходных файлов находится в [техническом описании (на английском)](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/technical-details.md).
