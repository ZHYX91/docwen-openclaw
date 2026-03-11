# DocWen × OpenClaw（Plugin + Skill）

本目录提供 OpenClaw 集成（建议独立成一个仓库进行发布与维护）：

- `plugin/`：OpenClaw Plugin（安装后在 Gateway 进程内运行，注册 `docwen_*` 工具）
- `plugin/skills/docwen/`：OpenClaw Skill（教模型如何使用这些工具；同一份可发布到 ClawHub）

## 适用场景

- 你在 OpenClaw 对话里想直接完成“文档转换/校对/PDF 合并拆分/表格汇总”
- 你希望 OpenClaw 调用本机 DocWenCLI，且尽量结构化、可控、可复现

## 安装与配置（给用户）

### 1) 安装插件（OpenClaw Plugin）

开发期（本地目录联调）：

```bash
openclaw plugins install -l ./plugin
```

发布后（npm 安装）：

```bash
openclaw plugins install <npm-spec>
```

### 2) 安装 Skill（ClawHub）

```bash
clawhub install docwen
```

### 3) 启用插件并配置（二选一）

方案 A：手工指定 DocWenCLI 路径（最稳，适合离线/企业网）

- `plugins.entries.docwen.enabled=true`
- `plugins.entries.docwen.config.binaryPath=".../DocWenCLI.exe"`（Windows）或 `".../DocWenCLI"`（Linux）

方案 B：自动下载 DocWenCLI（需要 Release assets 规范化）

- `plugins.entries.docwen.enabled=true`
- `plugins.entries.docwen.config.allowDownload=true`
- `plugins.entries.docwen.config.releaseRepo="ZHYX91/docwen"`
- `plugins.entries.docwen.config.releaseTag="vX.Y.Z"`

完整示例见：`plugin/openclaw-config.example.json5`

## 运行前自检

首次使用建议先在 OpenClaw 调用一次：

- `docwen_doctor`

## Release 资产约定（给维护者）

为了支持自动下载与校验，建议每个 tag 的 Release 至少包含：

- `DocWenCLI-win-x64.zip`
- `DocWenCLI-linux-x64.tar.gz`
- `SHA256SUMS.txt`

注意：压缩包应包含 DocWenCLI 运行所需的完整目录结构（至少包含 `DocWenCLI`/`DocWenCLI.exe`、`_internal/`、`templates/`、`configs/`、`docwen/i18n/locales/`）。

## 本地联调

1. 安装插件（开发模式 link）：

```bash
openclaw plugins install -l ./plugin
```

2. 将 Skill 放入当前 OpenClaw workspace：

把 `plugin/skills/docwen` 复制到 `<workspace>/skills/docwen`，确保存在 `<workspace>/skills/docwen/SKILL.md`。

3. 在 OpenClaw 配置中启用插件：

`plugins.entries.docwen.enabled=true`

如需手工指定 DocWenCLI 路径：

`plugins.entries.docwen.config.binaryPath="..."`。

如需自动下载，请设置 `releaseTag`（示例见 `plugin/openclaw-config.example.json5`）。

## 仓库结构说明（给贡献者）

- `plugin/src/index.ts`：OpenClaw 工具注册与参数 schema（`docwen_*`）
- `plugin/src/binary-manager.ts`：DocWenCLI 的下载/校验/落盘与缓存
- `plugin/skills/docwen/SKILL.md`：教模型如何使用工具的指令与工作流
