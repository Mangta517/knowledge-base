# Mangta 的公开项目知识库

基于 GitHub 公开项目的中文工程档案，记录固件、硬件及工具项目的设计、源码入口、技术专题和排障经验。由固定提交的精简快照支撑，并提供 Obsidian、站点和 AI 共用的索引。

| 入口 | 内容 |
| --- | --- |
| [总索引](index.md) | 项目、专题、ADR、排障和复盘 |
| [仓库清单](registry.yaml) | 盘点分级、快照 SHA、档案 SHA |
| [wiki/](wiki/) | Obsidian Vault，页面、互链和附件 |
| [raw/snapshots/](raw/snapshots/) | 公开仓库元数据、树和 README |
| [data/](data/) | 站点读取的目录、关系图和统计 JSON |
| [llms.txt](llms.txt) · [llms-full.txt](llms-full.txt) | AI 导航及核心合集 |
| [演进日志](log.md) | 各批次更新记录 |

## 本地使用

使用 PowerShell 7，在仓库根目录运行。需要 Python 3.12、uv、GitHub CLI 和已登录的 GitHub 账号。

```powershell
uv run python scripts/sync_github.py --discover
uv run python scripts/sync_github.py --sync <id>
uv run python scripts/sync_github.py --sync --all
uv run python scripts/sync_github.py --check-drift
uv run python scripts/build_indexes.py
uv run python scripts/lint_kb.py
uv run python scripts/build_indexes.py --check
```

`--discover` 合并账号拥有的公开仓。发现外部变化后，`--sync` 刷新指定仓库的快照，`--all` 遍历非忽略的公开仓。盘点与远端漂移检查都跳过发布范围之外的源。`snapshot_commit` 记录本地快照，`synced_commit` 记录人工审核过的档案版本。仅同步快照时，旧档案仍会在漂移检查中显示待更新状态。

在 Obsidian 选择 **打开本地仓库**，指向仓库根目录下的 `wiki`。项目从 `wiki/projects/` 浏览，全库导航在根目录 `index.md`。新增和刷新页面按 [AGENTS.md](AGENTS.md) 操作。
