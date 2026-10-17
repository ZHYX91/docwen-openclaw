# DocWen for OpenClaw

[English](https://github.com/ZHYX91/docwen-openclaw/blob/main/README.md) · [简体中文](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.zh-CN.md) · [繁體中文](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.zh-TW.md) · [Deutsch](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.de-DE.md) · [Français](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.fr-FR.md) · [Español](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.es-ES.md) · [Português](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.pt-BR.md) · [Русский](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.ru-RU.md) · [日本語](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.ja-JP.md) · [한국어](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.ko-KR.md) · [Tiếng Việt](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.vi-VN.md) · [العربية](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.ar.md)

استخدم DocWen من داخل OpenClaw لفحص المستندات وتحويل الملفات ومعالجة ملفات PDF وجداول البيانات. تبقى الملفات على الكمبيوتر الذي يشغّل OpenClaw Gateway، ويعالجها محليًا برنامج DocWen المثبّت على ذلك الكمبيوتر.

قبل استخدام هذه الإضافة، ثبّت **DocWen 0.12.0 أو أحدث** بشكل مستقل. [تنزيل الإضافة](https://github.com/ZHYX91/docwen-openclaw/releases).

## ما الذي يمكنك فعله

- التعرّف إلى صيغة الملف ومعرفة التحويلات المتاحة.
- فحص Markdown بحثًا عن مشكلات دون تعديل الملف الأصلي.
- تحويل المستندات ودمج ملفات PDF أو تقسيمها ودمج جداول البيانات أو الصور.

الأدوات التي تكتب الملفات أو تغيّرها **معطّلة افتراضيًا**. أنت تحدد الأدوات التي يُسمح لـ OpenClaw باستخدامها، ومكان حفظ النتائج.

## البدء السريع

1. **ثبّت DocWen بشكل مستقل.** على الكمبيوتر الذي يشغّل Gateway بنظام Windows x64 أو Ubuntu 24.04 x64، ثبّت [إصدارًا متوافقًا من DocWen](https://github.com/ZHYX91/docwen/releases) (0.12.0 أو أحدث). حدّد المسار المطلق الكامل للملف `DocWenCLI.exe` على Windows أو `DocWenCLI` على Linux. تثبيت الإضافة **لا يثبّت DocWen**.
2. **ثبّت إضافة OpenClaw.** نزّل ملف `openclaw-docwen-X.Y.Z.tgz` للإصدار المناسب من [صفحة إصدارات الإضافة](https://github.com/ZHYX91/docwen-openclaw/releases)، ثم ثبّته على الكمبيوتر الذي يشغّل Gateway:

   ```sh
   openclaw plugins install ./openclaw-docwen-X.Y.Z.tgz
   ```

3. **حدّد مكان DocWen في إعدادات الإضافة.** ابدأ بملف [`openclaw-config.example.json5`](../../openclaw-config.example.json5) الذي يفعّل أدوات القراءة فقط. استبدل قيمة `plugins.entries.docwen.config.binaryPath` بالمسار المطلق الفعلي لبرنامج DocWenCLI على **الكمبيوتر الذي يشغّل Gateway**. على Linux، استخدم الملف التنفيذي المثبّت. قائمة الأدوات المسموح بها في المثال هي:

   ```json5
   tools: {
     allow: ["docwen_info", "docwen_inspect", "docwen_resources", "docwen_validate_markdown"],
   }
   ```

   للسماح بالتحويل لاحقًا، أضف أداة الكتابة المطلوبة، مثل `"docwen_convert"`، إلى القائمة. السماح بـ `"docwen"` يفعّل المجموعة كاملة، بما فيها جميع أدوات الكتابة.

4. **اختبر الاتصال دون تغيير الملفات.** اطلب من OpenClaw تشغيل `docwen_info` للتحقق من جاهزية DocWen. ثم استخدم `docwen_inspect` لفحص ملف، أو `docwen_resources` للبحث عن صيغة أو قالب، أو `docwen_validate_markdown` لفحص Markdown. وعندما تريد تحويل ملف، فعّل الأداة المناسبة واختر مجلد النتائج.

تحتاج أدوات التحويل إلى المسارات الكاملة لملفات الإدخال ومجلد نتائج على الكمبيوتر الذي يشغّل Gateway. اختر مجلدًا جديدًا: يؤدي ضبط `overwrite=true` إلى استبدال مجلد النتائج الموجود بالكامل، بما فيه جميع محتوياته. ويمكن لأداة ترقيم Markdown تعديل الملف الأصلي عند طلب `inPlace=true` صراحةً. إذا تعذّر التأكد من نتيجة الكتابة، فلن تعيد الإضافة المحاولة تلقائيًا. راجع [أمثلة الاستخدام (بالصينية)](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/examples/basic.md) للمهام الشائعة و[مرجع الإعدادات (بالإنجليزية)](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/technical-details.md#configuration) للإعدادات.

على Linux، إذا أفادت الإضافة بأن نظام ملفات مجلد النتائج غير مدعوم، فاختر مجلدًا على نظام ملفات Linux الأصلي. قد يحدث هذا مع أقراص Windows المركّبة داخل WSL.

## طريقة العمل

يستدعي OpenClaw ملف DocWen التنفيذي المحلي. فحص الملف لا يغيّره؛ أما تحويل الملفات أو دمجها فيتطلب إذنًا منفصلًا لأداة الكتابة، ومجلد نتائج تختاره بنفسك. تتحقق الإضافة من النتائج قبل حفظها، ولا تكرر تلقائيًا عملية كتابة تعذّر التأكد من نتيجتها.

يجب أن تشير المسارات إلى ملفات على **الكمبيوتر الذي يشغّل Gateway**، وليس إلى جهاز آخر متصل بـ OpenClaw. للاطلاع على قواعد الإدخال الدقيقة وسلوك الإلغاء وحالات الاستعادة، راجع [التفاصيل التقنية والأمنية (بالإنجليزية)](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/technical-details.md).

## الأدوات

| الأداة                        | وظيفتها                                 | الإذن          |
| ----------------------------- | --------------------------------------- | -------------- |
| `docwen_info`                 | التحقق من تثبيت DocWen والميزات المتاحة | قراءة فقط      |
| `docwen_inspect`              | تحديد صيغة الملف والإجراءات المتاحة     | قراءة فقط      |
| `docwen_resources`            | استعراض الصيغ والقوالب وأنظمة الترقيم   | قراءة فقط      |
| `docwen_validate_markdown`    | فحص Markdown والإبلاغ عن المشكلات       | قراءة فقط      |
| `docwen_convert`              | تحويل الملفات إلى الصيغة المختارة       | تُفعّل على حدة |
| `docwen_number_markdown`      | إضافة أرقام عناوين Markdown أو إزالتها  | تُفعّل على حدة |
| `docwen_merge_pdfs`           | دمج ملفات PDF بالترتيب المحدد           | تُفعّل على حدة |
| `docwen_split_pdf`            | استخراج صفحات PDF المحددة               | تُفعّل على حدة |
| `docwen_merge_tables`         | دمج جداول البيانات                      | تُفعّل على حدة |
| `docwen_merge_images_to_tiff` | دمج الصور في ملف TIFF                   | تُفعّل على حدة |

تعتمد التحويلات المتاحة على برنامج DocWen المثبّت لديك. تتحقق الإضافة من الميزات التي يتيحها قبل بدء المهمة. لمعرفة حقول الإدخال وضوابط الكتابة، راجع [التفاصيل التقنية (بالإنجليزية)](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/technical-details.md).

## التطوير المحلي

```bash
npm ci
npm run check
npx openclaw plugins validate --root . --entry ./dist/index.js
```

استخدم بنية الإعدادات الموجودة في `openclaw-config.example.json5`. لمعرفة ما تغطيه الاختبارات وكيفية التحقق باستخدام حزمة DocWen جاهزة، راجع [الاختبارات والتحقق من الحزم (بالإنجليزية)](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/technical-details.md#testing-and-package-acceptance).

## الإصدارات

ثبّت إصدارًا من الإضافة عبر [صفحة GitHub Releases](https://github.com/ZHYX91/docwen-openclaw/releases). لمعرفة خطوات بناء الإصدار واختباره والتحقق منه ونشره، راجع [دليل الإصدار للقائمين على المشروع (بالإنجليزية)](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/releasing.md). تثبيت هذه الإضافة لا يثبّت DocWen ولا يحدّثه.

للتعرّف إلى تنظيم ملفات الشفرة المصدرية، راجع [التفاصيل التقنية (بالإنجليزية)](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/technical-details.md).
