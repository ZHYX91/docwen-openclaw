# DocWen für OpenClaw

[English](https://github.com/ZHYX91/docwen-openclaw/blob/main/README.md) · [简体中文](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.zh-CN.md) · [繁體中文](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.zh-TW.md) · [Deutsch](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.de-DE.md) · [Français](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.fr-FR.md) · [Español](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.es-ES.md) · [Português](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.pt-BR.md) · [Русский](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.ru-RU.md) · [日本語](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.ja-JP.md) · [한국어](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.ko-KR.md) · [Tiếng Việt](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.vi-VN.md) · [العربية](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.ar.md)

Mit DocWen können Sie in OpenClaw Dokumente prüfen, Dateien konvertieren sowie PDFs und Tabellen bearbeiten. Die Dateien bleiben auf dem Computer, auf dem Ihr OpenClaw Gateway läuft. Das Plugin verarbeitet sie lokal mit dem dort installierten DocWen.

Installieren Sie **DocWen 0.12.0 oder neuer** separat, bevor Sie dieses Plugin verwenden. [Plugin herunterladen](https://github.com/ZHYX91/docwen-openclaw/releases).

**OpenClaw-Voraussetzung:** Gateway und Plugin-API müssen `>=2026.7.1-2 <2027.0.0` erfüllen. Prüfen Sie die Gateway-Version vor der Installation; die beim Bau festgelegte SDK-Version ist keine Pflichtversion für den Gateway-Betrieb.

## Was Sie damit tun können

- Das Format einer Datei prüfen und verfügbare Konvertierungen anzeigen.
- Markdown auf Probleme prüfen, ohne das Original zu ändern.
- Dokumente konvertieren, PDFs zusammenführen oder aufteilen sowie Tabellen oder Bilder zusammenführen.

Werkzeuge, die Dateien erstellen oder ändern, sind **standardmäßig deaktiviert**. Sie entscheiden, welche davon OpenClaw verwenden darf und wo die Ergebnisse gespeichert werden.

## Schnellstart

1. **DocWen separat installieren.** Installieren Sie auf dem Computer mit Windows x64 oder Ubuntu 24.04 x64, auf dem Ihr Gateway läuft, eine kompatible [DocWen-Version](https://github.com/ZHYX91/docwen/releases) (0.12.0 oder neuer). Ermitteln Sie den vollständigen absoluten Pfad zu `DocWenCLI.exe` unter Windows oder `DocWenCLI` unter Linux. Die Installation dieses Plugins installiert DocWen **nicht** mit.
2. **Das OpenClaw-Plugin installieren.** Laden Sie die passende Datei `openclaw-docwen-X.Y.Z.tgz` von der [Release-Seite dieses Plugins](https://github.com/ZHYX91/docwen-openclaw/releases) herunter und installieren Sie sie auf dem Gateway-Computer:

   ```sh
   openclaw plugins install ./openclaw-docwen-X.Y.Z.tgz
   ```

3. **Den Pfad zu DocWen eintragen.** Beginnen Sie mit [`openclaw-config.example.json5`](../../openclaw-config.example.json5). Diese Beispielkonfiguration erlaubt nur lesende Werkzeuge. Ersetzen Sie `plugins.entries.docwen.config.binaryPath` durch den tatsächlichen absoluten Pfad zu DocWenCLI auf **Ihrem Gateway-Computer**; verwenden Sie unter Linux die installierte ausführbare Datei. Die Liste erlaubter Werkzeuge lautet:

   ```json5
   tools: {
     allow: ["docwen_info", "docwen_inspect", "docwen_resources", "docwen_validate_markdown"],
   }
   ```

   Um später Konvertierungen zu erlauben, ergänzen Sie das entsprechende schreibende Werkzeug, zum Beispiel `"docwen_convert"`, in dieser Liste. Der Eintrag `"docwen"` erlaubt die gesamte Gruppe, einschließlich aller schreibenden Werkzeuge.

4. **Die Verbindung prüfen, ohne Dateien zu ändern.** Bitten Sie OpenClaw, mit `docwen_info` zu prüfen, ob DocWen bereit ist. Prüfen Sie anschließend mit `docwen_inspect` eine Datei, suchen Sie mit `docwen_resources` ein Format oder eine Vorlage oder prüfen Sie mit `docwen_validate_markdown` Markdown. Wenn Sie eine Datei konvertieren möchten, erlauben Sie das entsprechende Werkzeug und wählen Sie den Ausgabeordner.

Konvertierungswerkzeuge benötigen vollständige Eingabepfade und einen Ausgabeordner auf dem Gateway-Computer. Wählen Sie einen neuen Ordner: `overwrite=true` ersetzt den gesamten vorhandenen Ausgabeordner einschließlich seines Inhalts. Die Markdown-Nummerierung kann auch die Originaldatei ändern, wenn ausdrücklich `inPlace=true` angefordert wird. Ist unklar, ob ein Schreibvorgang erfolgreich war, wiederholt das Plugin ihn nicht automatisch. Häufige Aufgaben finden Sie in den [Beispielen (Chinesisch)](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/examples/basic.md), Einstellungen in der [Konfigurationsreferenz (Englisch)](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/technical-details.md#configuration).

Wenn das Plugin unter Linux meldet, dass das Dateisystem des Ausgabeordners nicht unterstützt wird, wählen Sie einen Ordner auf einem nativen Linux-Dateisystem. Dies kann bei Windows-Laufwerken auftreten, die in WSL eingebunden sind.

**Bilder in Markdown:** Prüfen Sie vor Markdown → Word mit `docwen_info`, ob `convert.markdown_source.to_docx` verfügbar ist. Geben Sie Markdown als `source`-Dokument und jedes eingebundene Bild einzeln als `linked_resource` an. Der `logicalPath` muss dem Bildpfad im Markdown entsprechen; die Dateien müssen auf dem Gateway-Rechner liegen. Das Plugin sucht nicht in benachbarten Ordnern. Verwenden Sie `keepImages`, `ocr` und `ocrLanguage` nur, wenn die gewählte Funktion diese Optionen tatsächlich anbietet.

## So funktioniert es

OpenClaw ruft das lokal installierte DocWen-Programm auf. Das Prüfen einer Datei verändert sie nicht. Zum Konvertieren oder Zusammenführen müssen Sie das jeweilige schreibende Werkzeug gesondert erlauben und einen Ausgabeordner wählen. Das Plugin prüft die Ergebnisse vor dem Speichern und wiederholt einen Schreibvorgang mit ungewissem Ausgang nicht automatisch.

Pfade müssen auf Dateien auf dem **Gateway-Computer** verweisen, nicht auf einem anderen mit OpenClaw verbundenen Gerät. Die genauen Regeln für Eingaben, das Verhalten beim Abbrechen und die möglichen Zustände bei der Wiederherstellung sind in den [technischen Details und Sicherheitshinweisen (Englisch)](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/technical-details.md) beschrieben.

## Werkzeuge

| Werkzeug                      | Funktion                                                           | Berechtigung       |
| ----------------------------- | ------------------------------------------------------------------ | ------------------ |
| `docwen_info`                 | DocWen-Installation und verfügbare Funktionen prüfen               | Nur lesen          |
| `docwen_inspect`              | Dateiformat und verfügbare Aktionen ermitteln                      | Nur lesen          |
| `docwen_resources`            | Formate, Vorlagen und Nummerierungsschemata durchsuchen            | Nur lesen          |
| `docwen_validate_markdown`    | Markdown prüfen und Probleme melden                                | Nur lesen          |
| `docwen_convert`              | Dateien in das gewählte Format konvertieren                        | Gesondert erlauben |
| `docwen_number_markdown`      | Nummern zu Markdown-Überschriften hinzufügen oder daraus entfernen | Gesondert erlauben |
| `docwen_merge_pdfs`           | PDFs in der angegebenen Reihenfolge zusammenführen                 | Gesondert erlauben |
| `docwen_split_pdf`            | Ausgewählte PDF-Seiten extrahieren                                 | Gesondert erlauben |
| `docwen_merge_tables`         | Tabellen zusammenführen                                            | Gesondert erlauben |
| `docwen_merge_images_to_tiff` | Bilder zu einer TIFF-Datei zusammenführen                          | Gesondert erlauben |

Welche Konvertierungen verfügbar sind, hängt von Ihrer DocWen-Installation ab. Das Plugin prüft vor jeder Aufgabe die von DocWen gemeldeten Funktionen. Eingabefelder und Schutzmaßnahmen beim Schreiben sind in den [technischen Details (Englisch)](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/technical-details.md) beschrieben.

## Lokale Entwicklung

```bash
npm ci
npm run check
npx openclaw plugins validate --root . --entry ./dist/index.js
```

Orientieren Sie sich für den Aufbau der Konfiguration an `openclaw-config.example.json5`. Die [Dokumentation zu Tests und Paketprüfung (Englisch)](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/technical-details.md#testing-and-package-acceptance) beschreibt den Testumfang und die Prüfungen mit einem veröffentlichten DocWen-Paket.

## Veröffentlichungen

Installieren Sie eine Plugin-Version von der [GitHub-Releases-Seite](https://github.com/ZHYX91/docwen-openclaw/releases). Wie Sie eine Version bauen, testen, überprüfen und veröffentlichen, erklärt der [Veröffentlichungsleitfaden für Maintainer (Englisch)](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/releasing.md). Die Installation dieses Plugins installiert oder aktualisiert DocWen niemals.

Eine Übersicht der Quelldateien finden Sie in den [technischen Details (Englisch)](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/technical-details.md).
