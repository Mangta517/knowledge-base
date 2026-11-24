# 知识库维护规范

## 文件归属

- 人工维护 `wiki/` 的分析与个人复盘，并审核分级、发布策略及技术结论。Codex 负责盘点、快照、代码阅读、草拟页面和运行校验。
- 前端工程及部署由 Antigravity 维护，范围包括 `apps/`、`package.json`、`pnpm-workspace.yaml`、`scripts/build-site.mjs` 和 `.github/workflows/deploy-pages.yml`。
- `raw/snapshots/` 由同步脚本写入。`data/`、`index.md`、`llms.txt`、`llms-full.txt` 由索引脚本生成。将变更依据和每批结果追加到 `log.md`。
- 保留所有页面中 `HUMAN-NOTES:START` 到 `HUMAN-NOTES:END` 的边界和原文。刷新前先读现有文件，只更新区块之外的内容。

## 新仓入库或旧仓刷新

1. 使用 PowerShell 7 运行 `uv run python scripts/sync_github.py --discover`，审核 `registry.yaml` 的 `tier`、`publish_policy` 和 `domains`。公开仓按 `core`、`active`、`archive` 或 `ignore` 分级。`ignore` 保留盘点记录。
2. 运行 `uv run python scripts/sync_github.py --sync <id>`，然后按固定的 `snapshot_commit` 阅读 README、工程入口、配置和关键源码。只引用公共来源，验证公开可访问性及证据范围。
3. 从 `templates/` 复制对应模板。项目档案记录关键入口和证据范围，将通用结论连接到专题、ADR 或排障。复盘要区分源码事实、结构推断和实板验证。
4. 内容更新后，把同一完整 SHA 填入项目档案及 `registry.yaml` 的 `synced_commit`。仅拉取快照时保持内容 SHA 原值。追加日志并生成索引，再运行校验与漂移检查。

## 页面约定

- 页面的全局 ID 等于文件 basename。普通 ID 用英文 kebab-case，ADR 和排障分别用 `ADR-0001-slug`、`TS-0001-slug`。专题按域存放。
- 站内链接写 `[[id|显示文本]]`，用 YAML 的 `related_*` 补充结构化关系。正文内路径、目标名称和提交应能定位至公开源码。
- 使用标准 Obsidian Callout 和 Mermaid fenced code block。Mermaid 标签包含括号时加双引号。
- 生成数据只收录非草稿页面。当前库的项目档案及快照只发布源仓为 public 的内容。保持三份前端 JSON 的字段、路径和路由契约。
