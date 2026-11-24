import contextlib
import io
import json
import sys
import tempfile
import unittest
from datetime import date
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import build_indexes as indexes
import lint_kb as lint
import sync_github as sync

SHA = "a" * 40
NEW_SHA = "b" * 40
REVIEW = (
    "<!-- HUMAN-NOTES:START -->\n"
    "## 个人复盘与后续思考\n\n"
    "（由人工补充与维护）\n"
    "<!-- HUMAN-NOTES:END -->"
)


class TemporaryWorkspace(unittest.TestCase):
    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.enterContext(patch.object(lint, "ROOT", self.root))
        self.enterContext(patch.object(indexes, "ROOT", self.root))
        self.enterContext(patch.object(sync, "ROOT", self.root))
        self.enterContext(patch.object(sync, "REGISTRY", self.root / "registry.yaml"))

    def write(self, path, text):
        path = self.root / path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        return path


class LintTests(TemporaryWorkspace):
    def setUp(self):
        super().setUp()
        self.project = lint.Note(Path("wiki/projects/demo.md"), {
            "title": "示例", "description": "固件示例", "type": "project", "id": "demo", "tags": [],
            "created": date(2026, 11, 21), "updated": "2026-11-24", "draft": False,
            "repo": "owner/demo", "repo_url": "https://github.com/owner/demo",
            "visibility": "public", "publish_policy": "public", "tier": "core", "status": "maintained",
            "domains": ["embedded"], "tech_stack": ["STM32", "CAN", "Keil"],
            "primary_language": "C", "stars": 0, "synced_commit": SHA, "featured": True,
            "related_topics": [], "related_adrs": [],
        }, REVIEW)
        self.repos = {"demo": {
            **{key: self.project.meta[key] for key in lint.REGISTRY_FIELDS},
            "available": True, "snapshot_commit": SHA,
        }}

    def snapshot(self, commit=SHA):
        self.write("raw/snapshots/demo/meta.json", json.dumps({"commit": commit}))
        self.write("raw/snapshots/demo/readme.md", "README")
        self.write("raw/snapshots/demo/tree.txt", "src\nsrc/main file.c\nsrc/name(x).c\nMakefile\n")

    def test_frontmatter_fields_and_human_notes(self):
        malformed = self.write("wiki/projects/invalid.md", "---\n- list\n---\n")
        with self.assertRaisesRegex(ValueError, "YAML 映射"):
            lint.read_note(malformed)
        self.assertEqual(list(lint.check_fields(self.project)), [])
        self.project.meta["draft"] = "false"
        self.project.meta["updated"] = "2026-11-20"
        self.project.body = REVIEW.replace("HUMAN-NOTES:END", "OTHER:END")
        errors = "\n".join(lint.check_fields(self.project))
        for issue in ("draft 必须为布尔值", "updated 早于 created", "HUMAN-NOTES"):
            self.assertIn(issue, errors)

    def test_optional_visual_fields_validate_shape_and_length(self):
        self.project.meta.update(
            mcu="STM32F103C8",
            signal_flow=["接收", "解析", "发布"],
            highlights=[{"label": "接口", "value": "CAN"}, {"label": "内核", "value": "Cortex-M3"}],
        )
        self.assertEqual(list(lint.check_fields(self.project)), [])
        self.project.meta.update(mcu=None, signal_flow=["接收", "解析"], highlights=[{"label": "接口"}, None])
        errors = list(lint.check_fields(self.project))
        self.assertEqual([error.split()[0] for error in errors], ["mcu", "signal_flow", "highlights"])

    def test_reading_tracks_reject_unpublished_and_invalid_steps(self):
        draft = lint.Note(Path("wiki/topics/embedded/draft.md"), {"draft": True}, "")
        notes = {"demo": self.project, "draft": draft}
        self.assertEqual(lint.load_reading_tracks(notes), ([], []))
        self.write(lint.READING_TRACKS_PATH, """
- id: demo
  title: 示例路线
  summary: 示例介绍
  steps:
    - { id: demo, role: 入门, focus: 启动入口 }
    - { id: draft, role: 专题, focus: 草稿 }
    - { id: missing, role: 排障, focus: 失效节点 }
    - { id: demo, role: 专题, focus: "" }
""")
        _, errors = lint.load_reading_tracks(notes)
        self.assertEqual(len(errors), 3)
        self.assertIn("未发布或不存在 (draft)", errors[0])
        self.assertIn("未发布或不存在 (missing)", errors[1])
        self.assertIn("非空单行 id、role 和 focus", errors[2])

    def test_wikilink_format_and_bidirectional_relations(self):
        topic = lint.Note(Path("wiki/topics/embedded/bus.md"), {
            "type": "topic", "draft": False, "related_projects": [],
        }, "[[demo|档案]]")
        adr = lint.Note(Path("wiki/adr/ADR-0001-bus.md"), {
            "type": "adr", "draft": False, "related_projects": ["demo"],
        }, "")
        notes = {"demo": self.project, "bus": topic, adr.path.stem: adr}
        self.project.body = "[[bus]] [[missing|无效]] `[[hidden|样例]]`"
        self.project.meta["related_topics"] = ["bus"]
        errors, _ = lint.check_links(notes)
        self.assertEqual(len(errors), 4)
        self.assertTrue(any("[[id|显示文本]]" in error for error in errors))
        self.assertTrue(any("引用目标不存在或类型不符 missing" in error for error in errors))
        self.assertTrue(any("related_projects 缺少反向关联 demo" in error for error in errors))
        self.assertTrue(any("related_adrs 缺少反向关联 ADR-0001-bus" in error for error in errors))
        self.project.body = "[[bus|专题]]"
        topic.meta["related_projects"] = ["demo"]
        self.project.meta["related_adrs"] = [adr.path.stem]
        self.assertEqual(lint.check_links(notes), ([], []))

    def test_registry_matches_snapshot_and_public_project(self):
        self.snapshot()
        notes = {"demo": self.project}
        self.assertEqual(lint.check_content(notes, {"repos": self.repos}), ([], []))
        self.project.meta["stars"] = 1
        self.snapshot(NEW_SHA)
        (self.root / "raw/snapshots/demo/readme.md").unlink()
        errors, _ = lint.check_registry(notes, self.repos)
        self.assertEqual(len(errors), 3)
        self.assertTrue(any("stars" in error for error in errors))
        self.assertTrue(any("commit 与 snapshot_commit" in error for error in errors))
        self.assertTrue(any("readme.md" in error for error in errors))
        errors, _ = lint.check_registry({}, self.repos)
        self.assertTrue(any("缺少对应的公开项目档案" in error for error in errors))
        errors, _ = lint.check_registry(notes, {})
        self.assertTrue(any("项目未登记" in error for error in errors))

    def test_source_links_validate_refs_and_tree_paths(self):
        self.snapshot()
        repo = "https://github.com/OWNER/Demo"
        self.project.body = (
            f"[有效]({repo}/blob/{SHA}/src/main%20file.c#L2-L6)\n"
            f"<{repo}/blob/{SHA}/src/name(x).c>\n"
            f"[目录]({repo}/tree/{SHA}/src/)\n"
            f"[浮动]({repo}/blob/main/Makefile)\n"
            f"[旧提交]({repo}/blob/{NEW_SHA}/Makefile)\n"
            f"[死链]({repo}/blob/{SHA}/src/MAIN%20file.c)\n"
            f"[空路径]({repo}/blob/{SHA}/)\n"
            f"[文件当作目录]({repo}/tree/{SHA}/Makefile)\n"
            f"[目录当作文件]({repo}/blob/{SHA}/src)\n"
            f"`{repo}/blob/main/ignored`\n"
            f"<!-- {repo}/blob/main/ignored -->\n"
            f"```text\n{repo}/blob/main/ignored\n```\n"
            "[外部](" + repo.replace("Demo", "Other") + "/blob/main/README.md)"
        )
        errors, trees = lint.check_registry({"demo": self.project}, self.repos)
        self.assertEqual(errors, [])
        registered = {"owner/demo": ("demo", SHA)}
        errors = list(lint.check_source_links(self.project, registered, trees))
        self.assertEqual(len(errors), 6)
        self.assertIn("固定 40 位 SHA", errors[0])
        self.assertIn("synced_commit 不一致", errors[1])
        self.assertTrue(all("快照目录树中不存在" in error for error in errors[2:]))
        self.repos["demo"]["snapshot_commit"] = NEW_SHA
        self.snapshot(NEW_SHA)
        errors, trees = lint.check_registry({"demo": self.project}, self.repos)
        self.assertEqual((errors, trees), ([], {}))
        self.assertEqual(len(list(lint.check_source_links(self.project, registered, trees))), 2)

    def test_mermaid_static_checks(self):
        self.project.body = (
            "```mermaid\n\n```\n"
            "~~~mermaid\n%% 暂无\n~~~\n"
            "```mermaid\nunsupported TD\n```\n"
            "```mermaid\nflowchart TD\nA[文本(带括号)] --> B[\"正常(带括号)\"]\n```\n"
            "```mermaid\nflowchart TD\nA[(\"存储(v2)\")] --> B[[\"子流程(v2)\"]]\n```\n"
            "```mermaid\n%% 注释\nstateDiagram-v2\n[*] --> Idle\n```\n"
            "<!--\n```mermaid\nignored\n```\n-->\n"
            "````text\n```mermaid\nignored\n```\n````\n"
        )
        errors = list(lint.check_mermaid(self.project))
        self.assertEqual(len(errors), 4)
        self.assertIn("必须使用双引号", errors[-1])
        self.assertIn("文本(带括号)", errors[-1])

    def test_secret_scan_and_redaction(self):
        self.write("registry.yaml", "owner: owner\nrepos: {}\n")
        token = "ghp_" + "x" * 32
        self.write("actual.txt", "\n" + token)
        for path in ("apps/portal/.astro/cache.json", "apps/portal/public/wiki-assets/image.svg", "pnpm-lock.yaml", "uv.lock"):
            self.write(path, token)
        self.assertEqual(list(lint.secret_hits("\n" + token)), [("GitHub token", 2)])
        self.assertEqual(lint.redact_secrets("错误：" + token), "错误：[已隐藏]")
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            self.assertEqual(lint.main(), 1)
        self.assertIn("actual.txt:2: 疑似凭据 (GitHub token)", output.getvalue())
        self.assertNotIn(token, output.getvalue())
        self.assertNotIn("cache.json", output.getvalue())
        self.assertNotIn("image.svg", output.getvalue())
        self.assertNotIn("lock", output.getvalue())


class TroubleshootingTests(unittest.TestCase):
    def setUp(self):
        self.note = lint.Note(Path("wiki/troubleshooting/TS-0001-demo.md"), {
            "title": "示例", "description": "排障示例", "type": "troubleshooting", "id": "TS-0001-demo",
            "tags": [], "created": "2026-11-21", "updated": "2026-11-24", "draft": False,
            "ts_id": "TS-0001", "severity": "medium", "related_projects": [],
            "phases": ["接收", "校验", "发布"], "root_cause": "缺少结束标记", "located_by": "抓取接收帧",
        }, REVIEW)

    def test_published_visual_fields_are_required(self):
        for key in ("phases", "root_cause", "located_by"):
            del self.note.meta[key]
        self.assertEqual(list(lint.check_fields(self.note)), [
            "公开排障页缺少字段 phases",
            "公开排障页缺少字段 root_cause",
            "公开排障页缺少字段 located_by",
        ])
        self.note.meta["draft"] = True
        self.assertEqual(list(lint.check_fields(self.note)), [])

    def test_summary_requires_nonempty_single_line_of_at_most_120_chars(self):
        self.assertEqual(list(lint.check_fields(self.note)), [])
        for key in ("root_cause", "located_by"):
            for value in ("", "   ", "第一行\n第二行", "结尾换行\n", ["列表"], 1, None, "字" * 121):
                with self.subTest(key=key, value=value):
                    self.note.meta[key] = value
                    errors = list(lint.check_fields(self.note))
                    self.assertEqual(len(errors), 1)
                    self.assertTrue(errors[0].startswith(f"{key} "))
            self.note.meta[key] = "字" * 120
        self.assertEqual(list(lint.check_fields(self.note)), [])
        self.note.meta["draft"] = True
        self.note.meta["located_by"] = "第一行\n第二行"
        self.assertEqual(list(lint.check_fields(self.note)), ["located_by 必须是非空单行字符串"])

    def test_phases_requires_three_to_five_single_lines(self):
        for value in ("接收", [], ["接收"] * 2, ["接收"] * 6, ["接收", " ", "发布"], ["接收", "校\n验", "发布"]):
            with self.subTest(value=value):
                self.note.meta["phases"] = value
                self.assertEqual(list(lint.check_fields(self.note)), ["phases 必须含 3–5 个非空单行字符串"])
        self.note.meta["phases"] = ["接收", "校验", "暂存", "提交", "发布"]
        self.assertEqual(list(lint.check_fields(self.note)), [])

    def test_core_sections_require_visible_second_level_headings(self):
        self.note.body = (
            "### 错误原因与触发机理\n\n"
            "<!--\n## 错误原因与触发机理\n-->\n\n"
            "<!-- 备注 -->## 错误原因与触发机理\n\n"
            "```markdown\n## 定位过程与关键证据\n```\n\n"
            "> ## 具体排查流程\n\n"
            + REVIEW.replace("## 个人复盘与后续思考", "## 具体排查流程")
        )
        notes = {self.note.path.stem: self.note}
        errors, warnings = lint.check_content(notes, {"repos": {}})
        self.assertEqual(warnings, [])
        self.assertEqual(len(errors), 3)
        for heading in ("错误原因与触发机理", "定位过程与关键证据", "具体排查流程"):
            self.assertIn(f"{self.note.path}: 公开排障页缺少二级标题「{heading}」", errors)
        self.note.meta["draft"] = True
        self.assertEqual(lint.check_content(notes, {"repos": {}}), ([], []))
        self.note.meta["draft"] = False
        self.note.body = "## 错误原因与触发机理\n\n  ## 定位过程与关键证据 ##\n\n## 具体排查流程\n\n" + REVIEW
        self.assertEqual(lint.check_content(notes, {"repos": {}}), ([], []))


class IndexTests(TemporaryWorkspace):
    def test_word_count_removes_markdown_targets_and_keeps_code(self):
        markup = f'''<!-- hidden words -->
[驱动](https://github.com/owner/demo/blob/{SHA}/a(b)c.c "extra title") ![示意](<images/name file.svg>)
```text
int port
```
{REVIEW}
'''
        self.assertEqual(indexes.word_count(markup), indexes.word_count("驱动 示意 text int port"))
        self.assertEqual(indexes.word_count("`[keep](literal text)`"), 3)
        self.assertEqual(indexes.table_count("| A | B |\n| :- | -: |\n```text\n| a |\n| --- |\n```"), 1)

    def test_human_notes_and_corpus_links(self):
        self.assertFalse(indexes.has_human_notes(REVIEW))
        self.assertFalse(indexes.has_human_notes(REVIEW.replace("（由人工补充与维护）", "<!-- 提示 -->")))
        actual = REVIEW.replace("（由人工补充与维护）", "板上测得两次重试。")
        self.assertTrue(indexes.has_human_notes(actual))
        adr = lint.Note(Path("wiki/adr/ADR-0001-demo.md"), {}, "")
        project = lint.Note(Path("wiki/projects/demo.md"), {}, actual + "\n[[ADR-0001-demo|详见]]\n`[[ADR-0001-demo|示例]]`")
        body = indexes.corpus_body(project, {"ADR-0001-demo": adr})
        self.assertIn("板上测得两次重试。", body)
        self.assertIn("[详见](./adr/adr-0001-demo/)", body)
        self.assertIn("`[[ADR-0001-demo|示例]]`", body)
        self.assertNotIn("HUMAN-NOTES", body)
        self.assertEqual(indexes.clean_body(REVIEW), "")

    def test_timestamp_reuse_includes_added_fields(self):
        stamp = "2026-11-24T03:04:05Z"
        data = [{"projects": [{"mermaid_count": 2}]}, {"nodes": [], "edges": []}, {"counts": {"total_mermaids": 2}}]
        self.assertIsNone(indexes.reuse_timestamp(data))
        for path, payload in zip(indexes.JSON_PATHS, data, strict=True):
            self.write(path, indexes.json_text({"generated_at": stamp, **payload}))
        self.assertEqual(indexes.reuse_timestamp(data), stamp)
        data[0]["projects"][0]["mermaid_count"] = 3
        self.assertIsNone(indexes.reuse_timestamp(data))

    def test_recent_updates_sort_by_date_then_type_then_id(self):
        entries = [
            ("2026-11-24", "adr", "b"), ("2026-11-24", "adr", "a"),
            ("2026-11-24", "troubleshooting", "t"), ("2026-11-25", "project", "p"),
        ]
        items = [dict(zip(("updated", "type", "id"), entry)) for entry in entries]
        self.assertEqual([item["id"] for item in sorted(items, key=indexes.recent_update_key)], ["p", "t", "a", "b"])


class SyncTests(TemporaryWorkspace):
    def setUp(self):
        super().setUp()
        self.remote = {
            "nameWithOwner": "owner/demo", "defaultBranchRef": {"name": "main"},
            "url": "https://github.com/owner/demo", "description": "", "isFork": False, "isArchived": False,
            "primaryLanguage": {"name": "C"}, "stargazerCount": 0,
        }
        self.repos = {"owner/demo": self.remote}
        self.item = {"repo": "owner/demo", "tier": "core", "synced_commit": SHA, "snapshot_commit": SHA}
        self.registry = {"owner": "owner", "repos": {"demo": self.item}}
        self.head = {"sha": SHA, "commit": {"tree": {"sha": NEW_SHA}, "committer": {"date": "2026-11-24"}}}
        self.enterContext(patch.object(sync, "head", return_value=self.head))

    def test_incremental_sync_skips_complete_snapshot_and_repairs_missing_file(self):
        for name in lint.SNAPSHOT_FILES:
            self.write(f"raw/snapshots/demo/{name}", json.dumps({"commit": SHA}))
        with (patch.object(sync, "tree_paths", return_value=["main.c"]) as tree,
              patch.object(sync, "download_readme", return_value="# README") as readme,
              contextlib.redirect_stdout(io.StringIO())):
            sync.sync_one("demo", self.item, self.remote)
            tree.assert_not_called()
            readme.assert_not_called()
            sync.sync_one("demo", self.item, self.remote, force=True)
            tree.assert_called_once()
            readme.assert_called_once()
            (self.root / "raw/snapshots/demo/readme.md").unlink()
            sync.sync_one("demo", self.item, self.remote)
            self.assertEqual(tree.call_count, 2)
            self.assertEqual(readme.call_count, 2)
            self.assertEqual(self.item["synced_commit"], SHA)

    def test_batch_sync_persists_only_changed_snapshot_sha(self):
        sync.write_registry(self.registry)
        for name in lint.SNAPSHOT_FILES:
            self.write(f"raw/snapshots/demo/{name}", json.dumps({"commit": SHA}))
        with (patch.object(sync, "inventory", return_value=("owner", self.repos)),
              patch.object(sync, "tree_paths", return_value=["main.c"]) as tree,
              patch.object(sync, "download_readme", return_value="# README"),
              patch.object(sync, "write_registry", wraps=sync.write_registry) as write_registry,
              patch.object(sys, "argv", ["sync_github.py", "--sync", "--all"]),
              contextlib.redirect_stdout(io.StringIO())):
            self.assertEqual(sync.main(), 0)
            write_registry.assert_not_called()
            tree.assert_not_called()
            self.head["sha"] = NEW_SHA
            self.assertEqual(sync.main(), 0)
            write_registry.assert_called_once()
            tree.assert_called_once()
        saved = lint.load_yaml(sync.REGISTRY)["repos"]["demo"]
        self.assertEqual(saved["snapshot_commit"], NEW_SHA)
        self.assertEqual(saved["synced_commit"], SHA)

    def test_drift_table_and_json_report_three_states(self):
        self.assertEqual(list(sync.drift_rows(self.registry, self.repos))[0]["status"], "up_to_date")
        self.head["sha"] = NEW_SHA
        self.assertEqual(list(sync.drift_rows(self.registry, self.repos))[0]["status"], "snapshot_outdated")
        self.item["snapshot_commit"] = NEW_SHA
        with contextlib.redirect_stdout(io.StringIO()) as output:
            sync.drift(self.registry, self.repos, as_json=True)
        self.assertEqual(json.loads(output.getvalue()), [{
            "id": "demo", "repo": "owner/demo", "synced_commit": SHA,
            "snapshot_commit": NEW_SHA, "remote_head": NEW_SHA, "status": "content_outdated",
        }])
        with contextlib.redirect_stdout(io.StringIO()) as output:
            sync.drift(self.registry, self.repos)
        self.assertIn("知识档案 SHA\t快照 SHA\t远端 HEAD", output.getvalue())
        self.assertIn("快照已更新，待刷新档案", output.getvalue())


class CurrentRepositoryTests(unittest.TestCase):
    def test_published_contract_and_offline_checks(self):
        notes, errors = lint.load_notes()
        self.assertEqual(errors, [])
        registry = lint.load_yaml(ROOT / "registry.yaml")
        self.assertEqual(lint.check_content(notes, registry), ([], []))
        self.assertEqual(list(lint.scan_secrets()), [])

        published = {key: notes[key] for key in sorted(notes) if notes[key].meta["draft"] is False}
        tracks, route_errors = lint.load_reading_tracks(notes)
        self.assertEqual(route_errors, [])
        catalog, graph, stats = indexes.build_data(published, registry["owner"], tracks)
        self.assertIsNotNone(indexes.reuse_timestamp((catalog, graph, stats)))
        self.assertEqual(set(catalog), {
            "owner", "projects", "topics", "adrs", "troubleshooting", "synthesis", "link_map", "reading_tracks",
        })
        self.assertEqual(catalog["reading_tracks"], tracks)
        self.assertEqual(catalog["link_map"], {key: note.route for key, note in published.items()})
        self.assertEqual(set(graph), {"nodes", "edges"})
        self.assertEqual(set(stats), {"counts", "by_tier", "by_domain", "by_tech_stack", "by_language", "recent_updates"})
        self.assertEqual({node["id"]: node["route"] for node in graph["nodes"]}, catalog["link_map"])
        for node in graph["nodes"]:
            self.assertEqual(set(node), {"id", "title", "type", "route", "group", "degree"})
        for edge in graph["edges"]:
            self.assertEqual(set(edge), {"source", "target", "kind"})
            self.assertIn(edge["target"], published)
            self.assertIn(edge["source"], published)

        for kind, (directory, _) in lint.SECTIONS.items():
            for item in catalog[lint.OUTPUT_KEYS.get(kind, directory)]:
                note = published[item["id"]]
                for key in set(lint.COMMON + lint.FIELDS[kind]) - {"draft"}:
                    self.assertEqual(item[key], note.meta[key])
                for key in lint.VISUAL_FIELDS.get(kind, ()):
                    self.assertEqual(key in item, key in note.meta)
                    if key in note.meta:
                        self.assertEqual(item[key], note.meta[key])
                self.assertEqual(item["source_path"], note.path.as_posix())
                self.assertEqual(item["route"], note.route)
                for key in ("reading_minutes", "mermaid_count", "table_count", "evidence_count", "word_count"):
                    self.assertIs(type(item[key]), int)
                self.assertIs(type(item["has_human_notes"]), bool)
        for project in catalog["projects"]:
            self.assertEqual(project["related_troubleshooting"], sorted(
                issue["id"] for issue in catalog["troubleshooting"] if project["id"] in issue["related_projects"]
            ))

        text = indexes.build_text(published)
        self.assertEqual(text["llms-full.txt"].count("\n来源：wiki/"), len(published))
        self.assertIn("[知识库全文](./llms-full.txt)", text["llms.txt"])
        self.assertIn("[结构化目录](./data/catalog.json)", text["llms.txt"])
        for note in published.values():
            self.assertIn(f"({indexes.public_link(note)})", text["llms.txt"])
            self.assertIn(f"来源：{note.path.as_posix()}\n", text["llms-full.txt"])
