# DocWen pour OpenClaw

[English](https://github.com/ZHYX91/docwen-openclaw/blob/main/README.md) · [简体中文](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.zh-CN.md) · [繁體中文](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.zh-TW.md) · [Deutsch](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.de-DE.md) · [Français](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.fr-FR.md) · [Español](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.es-ES.md) · [Português](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.pt-BR.md) · [Русский](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.ru-RU.md) · [日本語](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.ja-JP.md) · [한국어](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.ko-KR.md) · [Tiếng Việt](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.vi-VN.md) · [العربية](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.ar.md)

Utilisez DocWen depuis OpenClaw pour vérifier des documents, convertir des fichiers et travailler avec des PDF et des feuilles de calcul. Les fichiers restent sur l’ordinateur qui exécute votre Gateway OpenClaw. Le plugin les traite localement avec DocWen installé sur cet ordinateur.

Installez séparément **DocWen 0.12.0 ou ultérieur** avant d’utiliser ce plugin. [Télécharger le plugin](https://github.com/ZHYX91/docwen-openclaw/releases).

**Version d’OpenClaw requise :** la Gateway et l’API du plugin doivent respecter `>=2026.7.1-2 <2027.0.0`. Vérifiez la version de la Gateway avant l’installation ; la version du SDK figée pour la compilation n’impose pas une version identique de la Gateway.

## Ce que vous pouvez faire

- Vérifier le format d’un fichier et voir les conversions disponibles.
- Rechercher des problèmes dans du Markdown sans modifier l’original.
- Convertir des documents, fusionner ou scinder des PDF, et regrouper des feuilles de calcul ou des images.

Les outils qui créent ou modifient des fichiers sont **désactivés par défaut**. Vous choisissez ceux qu’OpenClaw peut utiliser et où enregistrer les résultats.

## Démarrage rapide

1. **Installer DocWen séparément.** Sur l’ordinateur Windows x64 ou Ubuntu 24.04 x64 qui exécute votre Gateway, installez une [version compatible de DocWen](https://github.com/ZHYX91/docwen/releases) (0.12.0 ou ultérieur). Repérez le chemin absolu complet de `DocWenCLI.exe` sous Windows ou de `DocWenCLI` sous Linux. L’installation de ce plugin **n’installe pas** DocWen.
2. **Installer le plugin OpenClaw.** Téléchargez le fichier `openclaw-docwen-X.Y.Z.tgz` correspondant à la version souhaitée depuis la [page de publication du plugin](https://github.com/ZHYX91/docwen-openclaw/releases), puis installez-le sur l’ordinateur du Gateway :

   ```sh
   openclaw plugins install ./openclaw-docwen-X.Y.Z.tgz
   ```

3. **Indiquer au plugin le chemin de DocWen.** Commencez par [`openclaw-config.example.json5`](../../openclaw-config.example.json5), qui n’autorise que les outils en lecture seule. Remplacez `plugins.entries.docwen.config.binaryPath` par le chemin absolu réel de DocWenCLI sur **l’ordinateur de votre Gateway** ; sous Linux, utilisez l’exécutable installé. Voici la liste des outils autorisés :

   ```json5
   tools: {
     allow: ["docwen_info", "docwen_inspect", "docwen_resources", "docwen_validate_markdown"],
   }
   ```

   Pour autoriser ensuite une conversion, ajoutez l’outil d’écriture concerné, par exemple `"docwen_convert"`, à cette liste. Autoriser `"docwen"` active tout le groupe, y compris tous les outils d’écriture.

4. **Tester la connexion sans modifier de fichiers.** Demandez à OpenClaw d’exécuter `docwen_info` pour vérifier que DocWen est prêt. Utilisez ensuite `docwen_inspect` pour examiner un fichier, `docwen_resources` pour trouver un format ou un modèle, ou `docwen_validate_markdown` pour vérifier du Markdown. Pour convertir un fichier, autorisez l’outil correspondant et choisissez son dossier de sortie.

Les outils de conversion ont besoin des chemins complets des fichiers d’entrée et d’un dossier de sortie sur l’ordinateur du Gateway. Choisissez un nouveau dossier : `overwrite=true` remplace l’intégralité du dossier de sortie existant et de son contenu. La numérotation Markdown peut aussi modifier le fichier original si `inPlace=true` est explicitement demandé. Si le résultat d’une écriture est incertain, le plugin ne la relance pas automatiquement. Consultez les [exemples (en chinois)](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/examples/basic.md) pour les tâches courantes et la [référence de configuration (en anglais)](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/technical-details.md#configuration) pour les réglages.

Sous Linux, si le plugin indique que le système de fichiers de sortie n’est pas pris en charge, choisissez un dossier sur un système de fichiers Linux natif. Cela peut se produire avec des disques Windows montés dans WSL.

**Images dans Markdown :** avant Markdown → Word, vérifiez la disponibilité de `convert.markdown_source.to_docx` avec `docwen_info`. Fournissez le Markdown comme document `source` et chaque image liée séparément comme `linked_resource`. Son `logicalPath` doit correspondre au chemin écrit dans le Markdown, et tous les fichiers doivent se trouver sur l’ordinateur de la Gateway. Le plugin ne recherche pas d’images dans les dossiers voisins. Ne passez `keepImages`, `ocr` ou `ocrLanguage` que si la capacité choisie propose réellement ces options.

## Fonctionnement

OpenClaw appelle l’exécutable local de DocWen. Vérifier un fichier ne le modifie pas ; pour convertir ou fusionner des fichiers, vous devez autoriser séparément l’outil d’écriture concerné et choisir un dossier de sortie. Le plugin vérifie les résultats avant de les enregistrer et ne répète pas automatiquement une écriture dont le résultat est incertain.

Les chemins doivent désigner des fichiers sur **l’ordinateur du Gateway**, et non sur un autre appareil connecté à OpenClaw. Les [détails techniques et de sécurité (en anglais)](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/technical-details.md) précisent les règles concernant les fichiers d’entrée, le comportement en cas d’annulation et les états possibles lors de la récupération.

## Outils

| Outil                         | Fonction                                                       | Autorisation           |
| ----------------------------- | -------------------------------------------------------------- | ---------------------- |
| `docwen_info`                 | Vérifier l’installation de DocWen et les fonctions disponibles | Lecture seule          |
| `docwen_inspect`              | Identifier le format d’un fichier et les actions disponibles   | Lecture seule          |
| `docwen_resources`            | Parcourir les formats, modèles et schémas de numérotation      | Lecture seule          |
| `docwen_validate_markdown`    | Vérifier le Markdown et signaler les problèmes                 | Lecture seule          |
| `docwen_convert`              | Convertir des fichiers dans le format choisi                   | À autoriser séparément |
| `docwen_number_markdown`      | Ajouter ou retirer la numérotation des titres Markdown         | À autoriser séparément |
| `docwen_merge_pdfs`           | Regrouper des PDF dans l’ordre indiqué                         | À autoriser séparément |
| `docwen_split_pdf`            | Extraire les pages sélectionnées d’un PDF                      | À autoriser séparément |
| `docwen_merge_tables`         | Regrouper des feuilles de calcul                               | À autoriser séparément |
| `docwen_merge_images_to_tiff` | Regrouper des images dans un fichier TIFF                      | À autoriser séparément |

Les conversions disponibles dépendent de votre installation de DocWen. Avant de lancer une tâche, le plugin vérifie les fonctions annoncées par DocWen. Pour les champs à renseigner et les protections lors de l’écriture, consultez les [détails techniques (en anglais)](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/technical-details.md).

## Développement local

```bash
npm ci
npm run check
npx openclaw plugins validate --root . --entry ./dist/index.js
```

Utilisez `openclaw-config.example.json5` comme modèle de structure pour la configuration. La [documentation sur les tests et la validation des paquets (en anglais)](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/technical-details.md#testing-and-package-acceptance) décrit la couverture des tests et les vérifications effectuées avec une version de DocWen distribuée sous forme de paquet.

## Versions publiées

Installez une version du plugin depuis la [page GitHub Releases](https://github.com/ZHYX91/docwen-openclaw/releases). Pour compiler, tester, vérifier et publier une version, consultez le [guide de publication destiné aux responsables du projet (en anglais)](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/releasing.md). L’installation de ce plugin n’installe ni ne met à jour DocWen.

Pour une vue d’ensemble des fichiers source, consultez les [détails techniques (en anglais)](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/technical-details.md).
