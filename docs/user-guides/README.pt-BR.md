# DocWen para OpenClaw

[English](https://github.com/ZHYX91/docwen-openclaw/blob/main/README.md) · [简体中文](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.zh-CN.md) · [繁體中文](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.zh-TW.md) · [Deutsch](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.de-DE.md) · [Français](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.fr-FR.md) · [Español](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.es-ES.md) · [Português](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.pt-BR.md) · [Русский](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.ru-RU.md) · [日本語](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.ja-JP.md) · [한국어](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.ko-KR.md) · [Tiếng Việt](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.vi-VN.md) · [العربية](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/user-guides/README.ar.md)

Use o DocWen pelo OpenClaw para revisar documentos, converter arquivos e trabalhar com PDFs e planilhas. Os arquivos ficam no computador que executa seu Gateway do OpenClaw. O plugin os processa localmente usando o DocWen instalado nesse computador.

Instale **DocWen 0.12.0 ou posterior** separadamente antes de usar este plugin. [Baixar o plugin](https://github.com/ZHYX91/docwen-openclaw/releases).

## O que você pode fazer

- Verificar o formato de um arquivo e consultar as conversões disponíveis.
- Procurar problemas em Markdown sem alterar o original.
- Converter documentos, unir ou dividir PDFs e combinar planilhas ou imagens.

As ferramentas que criam ou alteram arquivos ficam **desativadas por padrão**. Você escolhe quais delas o OpenClaw pode usar e onde os resultados serão salvos.

## Primeiros passos

1. **Instale o DocWen separadamente.** No computador com Windows x64 ou Ubuntu 24.04 x64 que executa seu Gateway, instale uma [versão compatível do DocWen](https://github.com/ZHYX91/docwen/releases) (0.12.0 ou posterior). Localize o caminho absoluto completo de `DocWenCLI.exe` no Windows ou de `DocWenCLI` no Linux. A instalação deste plugin **não** instala o DocWen.
2. **Instale o plugin do OpenClaw.** Baixe o arquivo `openclaw-docwen-X.Y.Z.tgz` correspondente na [página de versões do plugin](https://github.com/ZHYX91/docwen-openclaw/releases) e instale-o no computador do Gateway:

   ```sh
   openclaw plugins install ./openclaw-docwen-X.Y.Z.tgz
   ```

3. **Informe ao plugin onde está o DocWen.** Comece com [`openclaw-config.example.json5`](../../openclaw-config.example.json5), que permite apenas ferramentas de leitura. Substitua `plugins.entries.docwen.config.binaryPath` pelo caminho absoluto real do DocWenCLI **no computador do seu Gateway**; no Linux, use o executável instalado. A lista de ferramentas permitidas é:

   ```json5
   tools: {
     allow: ["docwen_info", "docwen_inspect", "docwen_resources", "docwen_validate_markdown"],
   }
   ```

   Para autorizar conversões depois, adicione a ferramenta de escrita específica, como `"docwen_convert"`, a essa lista. Permitir `"docwen"` habilita o grupo inteiro, incluindo todas as ferramentas de escrita.

4. **Teste a conexão sem alterar arquivos.** Peça ao OpenClaw para executar `docwen_info` e verificar se o DocWen está pronto. Depois, use `docwen_inspect` para examinar um arquivo, `docwen_resources` para encontrar um formato ou modelo, ou `docwen_validate_markdown` para revisar Markdown. Quando quiser converter um arquivo, permita a ferramenta correspondente e escolha a pasta de saída.

As ferramentas de conversão precisam dos caminhos completos dos arquivos de entrada e de uma pasta de saída no computador do Gateway. Escolha uma pasta nova: `overwrite=true` substitui toda a pasta de saída existente e seu conteúdo. A numeração de Markdown também pode alterar o arquivo original quando `inPlace=true` é solicitado explicitamente. Se o resultado de uma escrita for incerto, o plugin não tentará executá-la de novo automaticamente. Consulte os [exemplos (em chinês)](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/examples/basic.md) para tarefas comuns e a [referência de configuração (em inglês)](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/technical-details.md#configuration) para os ajustes.

No Linux, se o plugin informar que o sistema de arquivos de saída não é compatível, escolha uma pasta em um sistema de arquivos nativo do Linux. Isso pode acontecer com unidades do Windows montadas no WSL.

## Como funciona

O OpenClaw chama o executável local do DocWen. Examinar um arquivo não o altera; para converter ou combinar arquivos, você precisa permitir separadamente a ferramenta de escrita correspondente e escolher uma pasta de saída. O plugin verifica os resultados antes de salvá-los e não repete automaticamente uma escrita cujo resultado seja incerto.

Os caminhos devem apontar para arquivos **no computador do Gateway**, e não em outro dispositivo conectado ao OpenClaw. Consulte os [detalhes técnicos e de segurança (em inglês)](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/technical-details.md) para conhecer as regras exatas de entrada, o comportamento de cancelamento e os estados de recuperação.

## Ferramentas

| Ferramenta                    | O que faz                                                  | Permissão              |
| ----------------------------- | ---------------------------------------------------------- | ---------------------- |
| `docwen_info`                 | Verificar a instalação do DocWen e os recursos disponíveis | Somente leitura        |
| `docwen_inspect`              | Identificar o formato de um arquivo e as ações disponíveis | Somente leitura        |
| `docwen_resources`            | Consultar formatos, modelos e esquemas de numeração        | Somente leitura        |
| `docwen_validate_markdown`    | Verificar Markdown e relatar problemas                     | Somente leitura        |
| `docwen_convert`              | Converter arquivos para o formato escolhido                | Permitir separadamente |
| `docwen_number_markdown`      | Adicionar ou remover a numeração dos títulos Markdown      | Permitir separadamente |
| `docwen_merge_pdfs`           | Unir PDFs na ordem informada                               | Permitir separadamente |
| `docwen_split_pdf`            | Extrair páginas selecionadas de um PDF                     | Permitir separadamente |
| `docwen_merge_tables`         | Combinar planilhas                                         | Permitir separadamente |
| `docwen_merge_images_to_tiff` | Combinar imagens em um TIFF                                | Permitir separadamente |

As conversões disponíveis dependem da sua instalação do DocWen. O plugin verifica os recursos que o DocWen informa estar disponíveis antes de iniciar uma tarefa. Para conhecer os campos de entrada e as proteções de escrita, consulte os [detalhes técnicos (em inglês)](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/technical-details.md).

## Desenvolvimento local

```bash
npm ci
npm run check
npx openclaw plugins validate --root . --entry ./dist/index.js
```

Use `openclaw-config.example.json5` como modelo da estrutura de configuração. A [documentação de testes e verificação de pacotes (em inglês)](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/technical-details.md#testing-and-package-acceptance) descreve a cobertura dos testes e as verificações com uma versão empacotada do DocWen.

## Versões publicadas

Instale uma versão do plugin pela [página do GitHub Releases](https://github.com/ZHYX91/docwen-openclaw/releases). Para compilar, testar, verificar e publicar uma versão, consulte o [guia de publicação para responsáveis pelo projeto (em inglês)](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/releasing.md). A instalação deste plugin nunca instala nem atualiza o DocWen.

Para ver como os arquivos de código-fonte estão organizados, consulte os [detalhes técnicos (em inglês)](https://github.com/ZHYX91/docwen-openclaw/blob/main/docs/technical-details.md).
