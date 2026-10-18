# DocWen para OpenClaw

[English](https://github.com/ZHYX91/docwen-openclaw/blob/main/README.md) · [简体中文](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.zh-CN.md) · [繁體中文](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.zh-TW.md) · [Deutsch](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.de-DE.md) · [Français](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.fr-FR.md) · [Español](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.es-ES.md) · [Português](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.pt-BR.md) · [Русский](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.ru-RU.md) · [日本語](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.ja-JP.md) · [한국어](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.ko-KR.md) · [Tiếng Việt](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.vi-VN.md) · [العربية](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.ar.md)

Usa DocWen desde OpenClaw para revisar documentos, convertir archivos y trabajar con PDF y hojas de cálculo. Los archivos permanecen en el equipo que ejecuta tu Gateway de OpenClaw. El plugin los procesa localmente con DocWen instalado en ese equipo.

Instala **DocWen 0.12.0 o posterior** por separado antes de usar este plugin. [Descargar el plugin](https://github.com/ZHYX91/docwen-openclaw/releases).

## Qué puedes hacer

- Comprobar el formato de un archivo y ver las conversiones disponibles.
- Buscar problemas en Markdown sin modificar el original.
- Convertir documentos, unir o dividir PDF y combinar hojas de cálculo o imágenes.

Las herramientas que crean o modifican archivos están **desactivadas por defecto**. Tú eliges cuáles puede usar OpenClaw y dónde se guardan los resultados.

## Inicio rápido

1. **Instala DocWen por separado.** En el equipo Windows x64 o Ubuntu 24.04 x64 que ejecuta tu Gateway, instala una [versión compatible de DocWen](https://github.com/ZHYX91/docwen/releases) (0.12.0 o posterior). Localiza la ruta absoluta completa de `DocWenCLI.exe` en Windows o de `DocWenCLI` en Linux. Instalar este plugin **no** instala DocWen.
2. **Instala el plugin de OpenClaw.** Descarga el archivo `openclaw-docwen-X.Y.Z.tgz` correspondiente desde la [página de versiones del plugin](https://github.com/ZHYX91/docwen-openclaw/releases) e instálalo en el equipo del Gateway:

   ```sh
   openclaw plugins install ./openclaw-docwen-X.Y.Z.tgz
   ```

3. **Indica al plugin dónde está DocWen.** Empieza con [`openclaw-config.example.json5`](../../openclaw-config.example.json5), que solo permite herramientas de lectura. Sustituye `plugins.entries.docwen.config.binaryPath` por la ruta absoluta real de DocWenCLI en **el equipo de tu Gateway**; en Linux, usa el ejecutable instalado. Esta es la lista de herramientas permitidas:

   ```json5
   tools: {
     allow: ["docwen_info", "docwen_inspect", "docwen_resources", "docwen_validate_markdown"],
   }
   ```

   Para autorizar conversiones más adelante, añade a esa lista la herramienta de escritura concreta, como `"docwen_convert"`. Permitir `"docwen"` habilita todo el grupo, incluidas todas las herramientas de escritura.

4. **Prueba la conexión sin modificar archivos.** Pide a OpenClaw que ejecute `docwen_info` para comprobar que DocWen está listo. Después, usa `docwen_inspect` para examinar un archivo, `docwen_resources` para buscar un formato o una plantilla, o `docwen_validate_markdown` para revisar Markdown. Cuando quieras convertir un archivo, permite la herramienta correspondiente y elige su carpeta de salida.

Las herramientas de conversión necesitan las rutas completas de los archivos de entrada y una carpeta de salida en el equipo del Gateway. Elige una carpeta nueva: `overwrite=true` sustituye toda la carpeta de salida existente y su contenido. La numeración de Markdown también puede modificar el archivo original si se solicita explícitamente `inPlace=true`. Si el resultado de una escritura es incierto, el plugin no la reintenta automáticamente. Consulta los [ejemplos (en chino)](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/examples/basic.md) para tareas habituales y la [referencia de configuración (en inglés)](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/technical-details.md#configuration) para los ajustes.

En Linux, si el plugin indica que el sistema de archivos de salida no es compatible, elige una carpeta en un sistema de archivos nativo de Linux. Esto puede ocurrir con unidades de Windows montadas en WSL.

## Cómo funciona

OpenClaw ejecuta el programa local de DocWen. Examinar un archivo no lo modifica; para convertir o combinar archivos, debes permitir por separado la herramienta de escritura correspondiente y elegir una carpeta de salida. El plugin comprueba los resultados antes de guardarlos y no repite automáticamente una escritura cuyo resultado sea incierto.

Las rutas deben apuntar a archivos en **el equipo del Gateway**, no en otro dispositivo conectado a OpenClaw. Consulta los [detalles técnicos y de seguridad (en inglés)](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/technical-details.md) para conocer las reglas exactas de entrada, el comportamiento de la cancelación y los estados de recuperación.

## Herramientas

| Herramienta                   | Qué hace                                                        | Permiso               |
| ----------------------------- | --------------------------------------------------------------- | --------------------- |
| `docwen_info`                 | Comprobar la instalación de DocWen y las funciones disponibles  | Solo lectura          |
| `docwen_inspect`              | Identificar el formato de un archivo y las acciones disponibles | Solo lectura          |
| `docwen_resources`            | Explorar formatos, plantillas y esquemas de numeración          | Solo lectura          |
| `docwen_validate_markdown`    | Revisar Markdown e informar de problemas                        | Solo lectura          |
| `docwen_convert`              | Convertir archivos al formato elegido                           | Permitir por separado |
| `docwen_number_markdown`      | Añadir o quitar la numeración de los títulos Markdown           | Permitir por separado |
| `docwen_merge_pdfs`           | Unir PDF en el orden indicado                                   | Permitir por separado |
| `docwen_split_pdf`            | Extraer las páginas seleccionadas de un PDF                     | Permitir por separado |
| `docwen_merge_tables`         | Combinar hojas de cálculo                                       | Permitir por separado |
| `docwen_merge_images_to_tiff` | Combinar imágenes en un TIFF                                    | Permitir por separado |

Las conversiones disponibles dependen de tu instalación de DocWen. El plugin comprueba las funciones que DocWen declara disponibles antes de iniciar una tarea. Para conocer los campos de entrada y las protecciones de escritura, consulta los [detalles técnicos (en inglés)](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/technical-details.md).

## Desarrollo local

```bash
npm ci
npm run check
npx openclaw plugins validate --root . --entry ./dist/index.js
```

Usa `openclaw-config.example.json5` como modelo de estructura para la configuración. Consulta la [documentación de pruebas y verificación de paquetes (en inglés)](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/technical-details.md#testing-and-package-acceptance) para conocer la cobertura de pruebas y las comprobaciones con una versión empaquetada de DocWen.

## Versiones publicadas

Instala una versión del plugin desde la [página de GitHub Releases](https://github.com/ZHYX91/docwen-openclaw/releases). Para compilar, probar, verificar y publicar una versión, consulta la [guía de publicación para responsables del proyecto (en inglés)](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/releasing.md). Instalar este plugin nunca instala ni actualiza DocWen.

Para ver cómo se organizan los archivos de código fuente, consulta los [detalles técnicos (en inglés)](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/technical-details.md).
