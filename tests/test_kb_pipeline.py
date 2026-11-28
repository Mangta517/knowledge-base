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

    def test_signal_flow_step_length_limit(self):
        self.project.meta["signal_flow"] = ["接收", "字" * 16, "发布"]
        self.assertEqual(list(lint.check_fields(self.project)), [])
        self.project.meta["signal_flow"][1] += "字"
        self.assertEqual(list(lint.check_fields(self.project)), ["signal_flow 第 2 步超过 16 字符"])

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

    def test_source_removed_from_public_inventory_blocks_publication(self):
        self.snapshot()
        self.repos["demo"]["available"] = False
        notes = {"demo": self.project}
        registry = {"owner": "owner", "repos": self.repos}
        errors, warnings = lint.check_content(notes, registry)
        self.assertEqual(warnings, [])
        self.assertEqual(len(errors), 2)
        self.assertIn(str(self.project.path), errors[0])
        self.assertIn(str(Path("raw/snapshots/demo")), errors[1])
        with (patch.object(lint, "load_notes", return_value=(notes, [])),
              patch.object(lint, "load_yaml", return_value=registry),
              contextlib.redirect_stdout(io.StringIO())):
            self.assertEqual(lint.main(), 1)
        with (patch.object(indexes, "load_notes", return_value=(notes, [])),
              patch.object(indexes, "load_yaml", return_value=registry),
              patch.object(sys, "argv", ["build_indexes.py"]),
              contextlib.redirect_stderr(io.StringIO())):
            self.assertEqual(indexes.main(), 1)
        self.assertFalse((self.root / "data/catalog.json").exists())

    def test_published_project_requires_snapshot_commit_and_files(self):
        notes = {"demo": self.project}
        self.repos["demo"]["snapshot_commit"] = None
        errors, _ = lint.check_content(notes, {"repos": self.repos})
        self.assertEqual(errors, [f"{self.project.path}: 公开档案的 snapshot_commit 必须是 40 位 Git SHA"])
        self.repos["demo"]["snapshot_commit"] = SHA
        errors, _ = lint.check_content(notes, {"repos": self.repos})
        self.assertEqual(len(errors), len(lint.SNAPSHOT_FILES))
        self.assertTrue(all("缺少快照文件" in error for error in errors))

    def test_embedded_asset_resolves_nested_path_for_catalog(self):
        self.write("wiki/assets/boards/front-panel.svg", "<svg/>")
        notes = {"demo": self.project}
        self.project.body = "![[front-panel.svg|面板]] ![[../assets/boards/front-panel.svg]]"
        self.assertEqual(lint.check_links(notes), ([], []))
        catalog, _, _ = indexes.build_data(notes, "owner")
        self.assertEqual(catalog["projects"][0]["assets"], {
            "front-panel.svg": "boards/front-panel.svg",
            "../assets/boards/front-panel.svg": "boards/front-panel.svg",
        })
        self.write("wiki/assets/other/front-panel.svg", "<svg/>")
        errors, _ = lint.check_links(notes)
        self.assertEqual(len(errors), 1)
        self.assertIn("图片名称不唯一", errors[0])
        self.project.body = "![[assets/boards/front-panel.svg]]"
        self.assertEqual(lint.check_links(notes), ([], []))

    def test_catalog_ignores_examples_in_markdown_code_blocks(self):
        self.write("wiki/assets/panel.svg", "<svg/>")
        self.project.body = (
            "    ![[example-only.svg]]\n\n"
            ">     ![[quoted-example.svg]]\n\n"
            "> ```markdown\n> ![[quoted-fence.svg]]\n> ```\n\n"
            "```text\n![[fenced-example.svg]]\n```\n\n"
            "示例 ``第一行\n![[multiline-example.svg]] `x` ``，以及正文。\n\n"
            "正文\n    ![[panel.svg]]"
        )
        notes = {"demo": self.project}
        self.assertEqual(lint.check_links(notes), ([], []))
        catalog, _, _ = indexes.build_data(notes, "owner")
        self.assertEqual(catalog["projects"][0]["assets"], {"panel.svg": "panel.svg"})

    def test_markdown_images_must_resolve_within_published_assets(self):
        self.write("wiki/assets/boards/board (v2).svg", "<svg/>")
        self.write("wiki/projects/internal.svg", "<svg/>")
        self.project.body = (
            "![面板 [v2]](../assets/boards/board%20(v2).svg#pins)\n\n"
            "![内部][outside]\n\n"
            "[outside]: internal.svg\n\n"
            "![外部](https://example.org/board.svg)\n\n"
            "    ![示例](internal.svg)\n"
        )
        errors, warnings = lint.check_links({"demo": self.project})
        self.assertEqual(warnings, [])
        self.assertEqual(len(errors), 1)
        self.assertIn("wiki/assets 下存在的文件 internal.svg", errors[0])

    def test_wikilink_with_square_brackets_reaches_graph(self):
        topic = lint.Note(Path("wiki/topics/embedded/bus.md"), {
            "title": "总线", "description": "总线说明", "type": "topic", "id": "bus", "tags": [],
            "created": "2026-11-24", "updated": "2026-11-24", "draft": False,
            "domain": "embedded", "related_projects": [],
        }, "")
        self.project.body = "[[bus|总线 [v2]]]，示例 `[[missing|版本 [v2]]]`"
        notes = {"demo": self.project, "bus": topic}
        self.assertEqual(lint.check_links(notes), ([], []))
        _, graph, _ = indexes.build_data(notes, "owner")
        self.assertEqual(graph["edges"], [{"source": "demo", "target": "bus", "kind": "wikilink"}])
        self.assertIn(r"[总线 \[v2\]](./topics/embedded/bus/)", indexes.corpus_body(self.project, notes))

    def test_unregistered_snapshot_blocks_lint_and_public_source_check(self):
        self.snapshot()
        errors, warnings = lint.check_content({}, {"repos": {}})
        self.assertEqual(warnings, [])
        self.assertEqual(len(errors), 1)
        self.assertIn("快照目录未登记在 registry.yaml", errors[0])
        self.repos["demo"]["snapshot_commit"] = None
        errors, _ = lint.check_registry({}, self.repos)
        self.assertIn("快照目录必须登记有效", errors[0])

        with (patch.object(sync, "load_notes", return_value=({}, [])),
              patch.object(sync, "gh") as gh,
              contextlib.redirect_stderr(io.StringIO()) as stderr):
            self.assertEqual(sync.check_public_sources({"repos": {}}), 1)
            gh.assert_not_called()
        self.assertIn("快照目录未登记", stderr.getvalue())

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

    def test_nonempty_fences_require_a_language(self):
        cases = (
            ("```\nuint8_t count;\n```", True),
            ("~~~   \noutput\n~~~", True),
            ("- 示例\n  ```\n  output\n  ```", True),
            ("> ```\n> output\n> ```", True),
            ("``` {#sample}\noutput\n```", True),
            ("```\noutput", True),
            ("~~~\n  \n~~~", False),
            ("```c++ {1}\nint count;\n```", False),
            ("~~~text\noutput\n~~~", False),
            ("<!--\n```\nexample\n```\n-->", False),
            ("````markdown\n```\nexample\n```\n````", False),
            ("    indented code", False),
        )
        for draft in (True, False):
            self.project.meta["draft"] = draft
            for body, fails in cases:
                with self.subTest(draft=draft, body=body):
                    self.project.body = body
                    errors = list(lint.check_markdown_format(self.project))
                    self.assertEqual(len(errors), int(fails))
                    if fails:
                        self.assertIn("代码块缺少语言标识", errors[0])

    def test_published_callouts_require_a_title_on_the_marker_line(self):
        self.project.body = (
            "> [!NOTE]   \n> 后续正文\n\n"
            "> [!WARNING]+\n> 后续正文\n\n"
            "> [!TIP] <!-- 隐藏注释 -->\n\n"
            "> [!note] 源码事实基线\n\n"
            "> [!TIP]- 调试记录\n\n"
            "> 普通引用\n\n"
            "> ## [!NOTE]\n\n"
            "```markdown\n> [!NOTE]\n```\n\n"
            "> ```text\n> [!NOTE]\n> ```\n\n"
            "<!--\n> [!NOTE]\n-->\n"
        )
        self.snapshot()
        notes = {"demo": self.project}
        registry = {"repos": self.repos}
        errors, warnings = lint.check_content(notes, registry)
        self.assertEqual(warnings, [])
        self.assertEqual(errors, [
            f"{self.project.path}: 正文第 {line} 行 Callout 缺少标题" for line in (1, 4, 7)
        ])
        self.project.meta["draft"] = True
        self.assertEqual(list(lint.check_markdown_format(self.project)), [])

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


class TroubleshootingTests(TemporaryWorkspace):
    def setUp(self):
        super().setUp()
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

    def test_phase_step_length_limit(self):
        self.note.meta["phases"] = ["接收", "字" * 16, "发布"]
        self.assertEqual(list(lint.check_fields(self.note)), [])
        self.note.meta["phases"][1] += "字"
        self.assertEqual(list(lint.check_fields(self.note)), ["phases 第 2 步超过 16 字符"])

    def test_core_sections_require_visible_second_level_headings(self):
        self.note.body = (
            "### 错误原因与触发机理\n\n"
            "<pre class=\"source\">\n\n## 错误原因与触发机理\n\n</pre>\n\n"
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
        self.assertEqual(indexes.word_count("[`appmain`](https://example.org/file)"), 1)
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

    def test_corpus_preserves_code_with_wikilinks_and_comments(self):
        examples = (
            "    [[demo|示例]] <!-- literal -->\n\n"
            ">     [[demo|引用示例]]\n\n"
            "示例 ``第一行\n[[demo|行内示例]] <!-- literal --> `x` ``。\n\n"
            "> ```md\n> [[demo|引用围栏]]\n> ```\n\n"
        )
        project = lint.Note(Path("wiki/projects/demo.md"), {}, examples + "[[demo|档案]]")
        self.assertEqual(indexes.corpus_body(project, {"demo": project}), examples + "[档案](./projects/demo/)")

    def test_corpus_rebases_inline_and_reference_attachments_to_site_root(self):
        body = (
            "[`手册`](<../../assets/boards/参考 (v2).pdf?mode=1&amp;lang=zh#pins> \"板卡手册\")\n\n"
            "> ![引脚][pins]\n>\n"
            "> [pins]:\n>   ../../assets/boards/pins.svg#top\n\n"
            "[原始源码](https://example.org/repo.pdf)\n\n"
            "普通文本](../../assets/boards/pins.svg#top)\n\n"
            "    [示例](../../assets/boards/pins.svg#top)\n\n"
            "`[示例](../../assets/boards/pins.svg#top)`"
        )
        note = lint.Note(Path("wiki/topics/embedded/demo.md"), {}, body)
        corpus = indexes.corpus_body(note, {})
        self.assertEqual(corpus, body.replace(
            "../../assets/boards/参考 (v2).pdf", "./wiki-assets/boards/%E5%8F%82%E8%80%83%20%28v2%29.pdf",
        ).replace(
            ">   ../../assets/boards/pins.svg#top", ">   <./wiki-assets/boards/pins.svg#top>",
        ))

    def test_timestamp_reuse_includes_added_fields(self):
        stamp = "2026-11-24T03:04:05Z"
        item = {"evidence_links": [{"label": "启动代码"}], "diagrams": [{"title": "启动流程"}]}
        data = [{"projects": [item]}, {"nodes": [], "edges": []}, {}]
        self.assertIsNone(indexes.reuse_timestamp(data))
        for path, payload in zip(indexes.JSON_PATHS, data, strict=True):
            self.write(path, indexes.json_text({"generated_at": stamp, **payload}))
        self.assertEqual(indexes.reuse_timestamp(data), stamp)
        for field, key in (("evidence_links", "label"), ("diagrams", "title")):
            with self.subTest(field=field), patch.dict(item[field][0], {key: "修改后"}):
                self.assertIsNone(indexes.reuse_timestamp(data))

    def test_extract_evidence_preserves_labels_heading_and_fixed_refs(self):
        repo = "https://github.com/Owner/Demo"
        base = f"{repo}/blob/{SHA}/src"
        external = f"https://github.com/other/external/tree/{NEW_SHA}"
        body = (
            f"<{external}>\n\n"
            f"## **接口** · `USART1`\n\n"
            f"<!-- {base}/comment.c\n## 隐藏标题\n-->\n\n"
            f"[`接收`驱动](<{base}/name\\(v2\\)%20test.c#L4-L8>)\n\n"
            f"`{base}/inline.c`\n\n"
            f"``示例\n{base}/multiline.c``\n\n"
            f"    {base}/indented.c\n\n"
            f"```md\n{base}/fenced.c\n```\n\n"
            f"{repo}/blob/main/src/not-pinned.c\n"
            f"{repo}/blob/{SHA}a/src/invalid-ref.c\n\n"
            f"### 接口 · USART1\n\n{base}/main.c#L20\n"
        )
        note = lint.Note(Path("wiki/projects/demo.md"), {"title": "示例"}, body)
        first, second, third = lint.extract_evidence_links(note, {"owner/demo": "demo"})
        self.assertEqual(first, {
            "url": external, "repo": "other/external", "kind": "tree", "commit": NEW_SHA,
            "path": "", "label": "other/external", "section": "",
        })
        self.assertEqual(second, {
            "url": f"{base}/name(v2)%20test.c#L4-L8", "repo": "Owner/Demo", "project_id": "demo", "kind": "blob",
            "commit": SHA, "path": "src/name(v2) test.c", "label": "接收驱动", "section": "接口 · USART1",
            "section_slug": "接口--usart1",
        })
        self.assertEqual(third["label"], "main.c")
        self.assertEqual(third["section_slug"], "接口--usart1-1")

    def test_extract_diagrams_uses_visible_headings_and_top_level_fences(self):
        note = lint.Note(Path("wiki/projects/demo.md"), {"title": "文档标题"}, (
            "```mermaid\nsequenceDiagram\n    A->>B: start\n```\n\n"
            "## 重复\n\n"
            "<!--\n### 隐藏\n```mermaid\nflowchart TD\n```\n-->\n\n"
            "> ### 引用标题\n> ```mermaid\n> graph BT\n> ```\n\n"
            "    ```mermaid\n    flowchart RL\n    ```\n\n"
            "- 列表\n\n  ```mermaid\n  flowchart TB\n  ```\n\n"
            "~~~mermaid\n%% 说明\n\ngraph LR; A --> B\n~~~\n\n"
            "### 重复-1\n\n"
            "### 重复\n\n"
            "```mermaid\nstateDiagram-v2\n[*] --> Idle\n```\n"
        ))
        self.assertEqual(lint.extract_diagrams(note), [
            {"index": 1, "diagram_type": "sequenceDiagram", "title": "文档标题", "source": "sequenceDiagram\n    A->>B: start"},
            {"index": 2, "diagram_type": "flowchart", "direction": "LR", "title": "重复", "section_slug": "重复",
             "source": "%% 说明\n\ngraph LR; A --> B"},
            {"index": 3, "diagram_type": "stateDiagram-v2", "title": "重复", "section_slug": "重复-2",
             "source": "stateDiagram-v2\n[*] --> Idle"},
        ])

    def test_evidence_stats_deduplicate_urls_without_fragments(self):
        base = f"https://github.com/owner/demo/blob/{SHA}"
        note = lint.Note(Path("wiki/topics/embedded/demo.md"), {
            "title": "示例", "description": "专题示例", "type": "topic", "id": "demo", "tags": [],
            "created": "2026-11-24", "updated": "2026-11-24", "draft": False, "domain": "embedded", "related_projects": [],
        }, f"{base}/main.c#L1\n{base}/main.c#L9\n{base}/other.c\n\n```mermaid\ngraph TD\nA --> B\n```\n")
        catalog, _, stats = indexes.build_data({"demo": note}, "owner")
        self.assertEqual(catalog["topics"][0]["evidence_count"], 3)
        self.assertEqual(stats["counts"]["unique_evidence_files"], 2)
        self.assertEqual(stats["by_evidence_repo"], {"owner/demo": {"project_id": None, "count": 3, "unique_files": 2}})
        self.assertEqual(stats["by_diagram_type"], {"flowchart": 1})

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

    def test_discovery_keeps_knowledge_base_in_inventory_as_ignored(self):
        repo = {**self.remote, "nameWithOwner": "Mangta517/Knowledge-Base", "diskUsage": 300,
                "primaryLanguage": {"name": "Python"}, "pushedAt": "2026-11-27T00:00:00Z"}
        repos = {"mangta517/knowledge-base": repo}
        registry = sync.discovered({"repos": {}}, "Mangta517", repos)
        item = registry["repos"]["knowledge-base"]
        self.assertTrue(item["available"])
        self.assertEqual(item["tier"], "ignore")
        self.assertIsNone(item["snapshot_commit"])
        self.assertEqual(list(sync.drift_rows(registry, repos))[0]["status"], "ignored")

    def test_check_public_queries_only_published_sources_and_fails_closed(self):
        self.registry["repos"]["ignored"] = {"repo": "owner/ignored", "tier": "ignore"}
        sync.write_registry(self.registry)
        before = sync.REGISTRY.read_bytes()
        project = lint.Note(Path("wiki/projects/demo.md"), {
            "repo": "Owner/Demo", "type": "project", "draft": False,
        }, "")
        draft = lint.Note(Path("wiki/projects/draft.md"), {
            "repo": "owner/draft", "type": "project", "draft": True,
        }, "")
        with (patch.object(sync, "load_notes", side_effect=lambda: ({"demo": project, "draft": draft}, [])),
              patch.object(sync, "gh", side_effect=[
                  {"private": False, "visibility": "public"}, {"private": True, "visibility": "private"},
                  sync.GitHubError("GitHub HTTP 404 (api)", 404),
              ]) as gh,
              patch.object(sys, "argv", ["sync_github.py", "--check-public"]),
              contextlib.redirect_stdout(io.StringIO()),
              contextlib.redirect_stderr(io.StringIO()) as errors):
            self.assertEqual(sync.main(), 0)
            self.assertEqual(sync.main(), 1)
            self.assertEqual(sync.main(), 1)
        self.assertEqual([call.args[1] for call in gh.call_args_list], ["repos/owner/demo"] * 3)
        self.assertIn("owner/demo: 源仓当前不是公开仓库", errors.getvalue())
        self.assertIn("owner/demo: GitHub HTTP 404", errors.getvalue())
        self.assertEqual(sync.REGISTRY.read_bytes(), before)
        self.assertFalse((self.root / ".snapshot-sync.lock").exists())

    def test_failed_snapshot_update_preserves_old_files_and_registry(self):
        sync.write_registry(self.registry)
        before = {
            self.write(f"raw/snapshots/demo/{name}", f"旧版 {name}"): f"旧版 {name}"
            for name in lint.SNAPSHOT_FILES
        }
        registry_before = sync.REGISTRY.read_bytes()
        self.head["sha"] = NEW_SHA
        write_text = sync.write_text
        replace = Path.replace

        def fail_write(path, content):
            if path.name == "readme.md":
                self.assertTrue((path.parent / "tree.txt").exists())
                raise OSError("README 写入失败")
            write_text(path, content)

        def fail_swap(path, destination):
            if destination.name == "demo" and not path.name.endswith(".previous"):
                raise OSError("快照目录替换失败")
            return replace(path, destination)

        with (patch.object(sync, "tree_paths", return_value=["main.c"]),
              patch.object(sync, "download_readme", return_value="# README")):
            with patch.object(sync, "write_text", side_effect=fail_write):
                with self.assertRaisesRegex(OSError, "README 写入失败"):
                    sync.sync_one("demo", self.item, self.remote, registry=self.registry)
            self.assertEqual({path: path.read_text(encoding="utf-8") for path in before}, before)

            with patch.object(Path, "replace", fail_swap):
                with self.assertRaisesRegex(OSError, "快照目录替换失败"):
                    sync.sync_one("demo", self.item, self.remote, registry=self.registry)
            self.assertEqual({path: path.read_text(encoding="utf-8") for path in before}, before)

            with patch.object(sync, "write_registry", side_effect=OSError("登记写入失败")):
                with self.assertRaisesRegex(OSError, "登记写入失败"):
                    sync.sync_one("demo", self.item, self.remote, registry=self.registry)
        self.assertEqual({path: path.read_text(encoding="utf-8") for path in before}, before)
        self.assertEqual(sync.REGISTRY.read_bytes(), registry_before)
        self.assertEqual(self.item["snapshot_commit"], SHA)
        self.assertEqual([path.name for path in (self.root / "raw/snapshots").iterdir()], ["demo"])

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
        self.assertTrue(all(route == route.lower() for route in catalog["link_map"].values()))
        self.assertEqual(set(graph), {"nodes", "edges"})
        self.assertEqual(set(stats), {
            "counts", "by_tier", "by_domain", "by_tech_stack", "by_language", "by_evidence_repo", "by_diagram_type", "recent_updates",
        })
        self.assertEqual(sum(repo["count"] for repo in stats["by_evidence_repo"].values()), stats["counts"]["total_evidence_links"])
        self.assertEqual(sum(stats["by_diagram_type"].values()), stats["counts"]["total_mermaids"])
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
                pinned_links = [link for link in lint.source_links(note.body) if lint.SHA.fullmatch(link["ref"])]
                self.assertEqual(len(item["evidence_links"]), item["evidence_count"])
                self.assertEqual(len(pinned_links), item["evidence_count"])
                self.assertEqual(len(item["diagrams"]), item["mermaid_count"])
                self.assertEqual([code.strip() for code in lint.mermaid_blocks(note.body)], [entry["source"] for entry in item["diagrams"]])
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
