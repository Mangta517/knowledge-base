"""Build the public JSON catalog, relationship graph and reading indexes."""

import argparse
import json
import re
import sys
from collections import Counter
from datetime import date, datetime, timezone

from lint_kb import (
    BLOCKS, COMMENT, COMMON, FIELDS, INLINE_CODE, NOTES, OUTPUT_KEYS, RELATED_TYPES, ROOT, SECTIONS, SHA, WIKILINK,
    VISUAL_FIELDS, check_content, load_notes, load_reading_tracks, load_yaml, mermaid_blocks, redact_secrets,
    source_links, visible_markup, wikilinks,
)

JSON_PATHS = ["data/catalog.json", "data/graph.json", "data/stats.json"]
RECENT_TYPE_ORDER = ("troubleshooting", "adr", "topic", "synthesis", "project")
EMPTY_REVIEW_LINES = re.compile(r"(?m)^[ \t]*(?:##[ \t]+个人复盘与后续思考|（由人工补充与维护）)[ \t]*$")
BODY_MARKUP = BLOCKS.pattern + "|" + INLINE_CODE.pattern
BODY_BLOCKS = re.compile(BODY_MARKUP, BLOCKS.flags)
INLINE_MARKUP = re.compile(
    BODY_MARKUP + r"|!?\[(?P<label>(?:[^\[\]\n]|\[[^\[\]\n]*\])*)\]\(\s*"
    r'(?:<[^>\n]*>|(?:\\.|[^()\s\\]|\([^()\n]*\))*)'
    r'''(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^()\n]*\)))?[ \t]*\)''', BLOCKS.flags
)
CORPUS_MARKUP = re.compile(BODY_MARKUP + "|" + WIKILINK.pattern, BLOCKS.flags)
TABLE_SEPARATOR = re.compile(r"\|?\s*:?-+:?(?:\s*\|\s*:?-+:?)*\s*\|?")


def json_text(data):
    return json.dumps(data, ensure_ascii=False, indent=2) + "\n"


def has_human_notes(text):
    return any(EMPTY_REVIEW_LINES.sub("", COMMENT.sub("", block)).strip() for block in NOTES.findall(text))


def clean_body(text):
    def strip_comment(block):
        if block["fence"] or block["ticks"]:
            return block[0]
        return ""

    if not has_human_notes(text):
        text = NOTES.sub("", text)
    return BODY_BLOCKS.sub(strip_comment, text).strip()


def word_count(text):
    def keep_label(match):
        if match["label"] is not None:
            return match["label"]
        return match[0]

    text = INLINE_MARKUP.sub(keep_label, clean_body(text))
    return len(re.findall(r"[\u3400-\u9fff]|[^\W\u3400-\u9fff]+", text))


def table_count(body):
    lines = visible_markup(body).splitlines()
    return sum(
        1
        for header, separator in zip(lines, lines[1:])
        if "|" in separator and header.strip() and TABLE_SEPARATOR.fullmatch(separator.strip())
    )


def recent_update_key(item):
    return (-date.fromisoformat(item["updated"]).toordinal(), RECENT_TYPE_ORDER.index(item["type"]), item["id"])


def build_data(notes, owner, reading_tracks=()):
    keys = {kind: OUTPUT_KEYS.get(kind, directory) for kind, (directory, _) in SECTIONS.items()}
    catalog = {"owner": owner, **{key: [] for key in keys.values()}, "link_map": {}}
    if reading_tracks:
        catalog["reading_tracks"] = reading_tracks
    edges = set()
    for note in notes.values():
        meta = note.meta
        source = meta["id"]
        kind = meta["type"]
        item = {key: meta[key] for key in COMMON + FIELDS[kind] if key != "draft"}
        item.update({key: meta[key] for key in VISUAL_FIELDS.get(kind, ()) if key in meta})
        words = word_count(note.body)
        item.update(
            route=note.route, source_path=note.path.as_posix(), word_count=words,
            reading_minutes=max(1, round(words / 350)),
            mermaid_count=sum(1 for _ in mermaid_blocks(note.body)),
            table_count=table_count(note.body),
            evidence_count=sum(1 for link in source_links(note.body) if SHA.fullmatch(link["ref"])),
            has_human_notes=has_human_notes(note.body),
        )
        catalog[keys[kind]].append(item)
        catalog["link_map"][source] = note.route
        for match in wikilinks(note.body):
            if not match["embed"]:
                edges.add((source, match["target"], "wikilink"))
        for key in RELATED_TYPES:
            edges.update((source, target, "frontmatter") for target in meta.get(key, ()))
    edges = sorted(edge for edge in edges if edge[0] != edge[1] and edge[1] in notes)
    neighbors = {source: set() for source in notes}
    for source, target, _ in edges:
        neighbors[source].add(target)
        neighbors[target].add(source)
    nodes = []
    for source, note in notes.items():
        meta = note.meta
        nodes.append({
            "id": source, "title": meta["title"], "type": meta["type"], "route": note.route,
            "group": meta.get("tier", meta.get("domain", meta["type"])), "degree": len(neighbors[source]),
        })
    graph = {"nodes": nodes, "edges": [dict(zip(("source", "target", "kind"), edge)) for edge in edges]}
    items = [item for key in keys.values() for item in catalog[key]]
    projects = catalog["projects"]
    for project in projects:
        project["related_troubleshooting"] = sorted(
            note["id"] for note in catalog["troubleshooting"] if project["id"] in note["related_projects"]
        )
    tier_counts = Counter(item["tier"] for item in projects)
    stats = {
        "counts": {
            **{key: len(catalog[key]) for key in keys.values()},
            "total_notes": len(items), "total_words": sum(item["word_count"] for item in items),
            "total_mermaids": sum(item["mermaid_count"] for item in items),
            "total_tables": sum(item["table_count"] for item in items),
            "total_evidence_links": sum(item["evidence_count"] for item in items),
        },
        "by_tier": {tier: tier_counts[tier] for tier in ("core", "active", "archive")},
        "by_domain": dict(sorted(Counter(domain for item in projects for domain in item["domains"]).items())),
        "by_tech_stack": dict(sorted(Counter(tech for item in projects for tech in item["tech_stack"]).items())),
        "by_language": dict(sorted(Counter(item["primary_language"] for item in projects).items())),
        "recent_updates": [
            {key: item[key] for key in ("id", "title", "type", "updated", "route", "description")}
            for item in sorted(items, key=recent_update_key)[:12]
        ],
    }
    return catalog, graph, stats


def public_link(note):
    return "." + note.route.lower()


def corpus_body(note, notes):
    def render(match):
        if match["target"] is None:
            return match[0]
        target = notes.get(match["target"])
        label = (match["label"] or "|" + match["target"])[1:]
        if target is None or match["embed"]:
            return label
        return f"[{label}]({public_link(target)})"

    return CORPUS_MARKUP.sub(render, clean_body(note.body))


def build_text(notes):
    index = ["# 知识库索引", "", "源自公开 GitHub 项目的工程档案与跨项目技术笔记。"]
    llms = [
        "# Mangta 的公开项目知识库", "", "> 固件、硬件和开发工具项目的设计记录与公开源码导航。", "",
        "- [知识库全文](./llms-full.txt)", "- [结构化目录](./data/catalog.json)",
    ]
    full = ["# Mangta 的公开项目知识库 · 全文合集"]
    optional = []
    for kind, (_, label) in SECTIONS.items():
        group = [note for note in notes.values() if note.meta["type"] == kind]
        index.extend(["", f"## {label}", ""])
        for note in group:
            meta = note.meta
            index.append(f"- [[{meta['id']}|{meta['title']}]] · {meta['description']}")
            summary = f"类型：{kind} · 路由：{public_link(note)}"
            if kind == "project":
                summary += f" · 仓库：{meta['repo_url']} · 提交：`{meta['synced_commit']}`"
            elif meta["related_projects"]:
                summary += " · 关联项目：" + "、".join(meta["related_projects"])
            full.extend([
                "", "---", "", f"# {meta['title']}", "", f"来源：{note.path.as_posix()}",
                summary, "", corpus_body(note, notes),
            ])
        links = []
        for note in group:
            meta = note.meta
            entry = f"- [{meta['title']}]({public_link(note)}): {meta['description']} · 来源 `{note.path.as_posix()}`"
            if kind == "project" and meta["tier"] != "core":
                optional.append(entry)
            else:
                links.append(entry)
        if links:
            if kind == "project":
                label = "核心项目"
            llms.extend(["", f"## {label}", "", *links])
    if optional:
        llms.extend(["", "## Optional", "", *optional])
    return dict(zip(("index.md", "llms.txt", "llms-full.txt"), ("\n".join(lines).rstrip() + "\n" for lines in (index, llms, full))))


def reuse_timestamp(payloads):
    stamps = set()
    for relative, payload in zip(JSON_PATHS, payloads):
        try:
            stored = json.loads((ROOT / relative).read_text(encoding="utf-8"))
            stamp = stored.pop("generated_at")
            if not stamp.endswith("Z") or stored != payload:
                return None
            datetime.fromisoformat(stamp)
            stamps.add(stamp)
        except (OSError, ValueError, KeyError, AttributeError, TypeError):
            return None
    if len(stamps) == 1:
        return stamps.pop()
    return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="验证索引与当前页面一致")
    args = parser.parse_args()
    notes, errors = load_notes()
    registry = load_yaml(ROOT / "registry.yaml")
    content_errors, _ = check_content(notes, registry)
    errors.extend(content_errors)
    reading_tracks, route_errors = load_reading_tracks(notes)
    errors.extend(route_errors)
    if errors:
        for error in errors:
            print(f"ERROR {redact_secrets(error)}", file=sys.stderr)
        return 1
    notes = {key: notes[key] for key in sorted(notes) if notes[key].meta["draft"] is False}
    payloads = build_data(notes, registry["owner"], reading_tracks)
    stamp = reuse_timestamp(payloads)
    if stamp is None:
        stamp = datetime.now(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")
    outputs = build_text(notes)
    outputs.update({
        relative: json_text({"generated_at": stamp, **payload})
        for relative, payload in zip(JSON_PATHS, payloads)
    })
    stale = []
    for relative, content in outputs.items():
        path = ROOT / relative
        if path.is_file() and path.read_text(encoding="utf-8") == content:
            continue
        stale.append(relative)
        if not args.check:
            path.parent.mkdir(exist_ok=True)
            path.write_text(content, encoding="utf-8", newline="\n")
    if args.check and stale:
        print("请重新生成： " + ", ".join(stale), file=sys.stderr)
        return 1
    print(f"{len(notes)} 篇公开页面，{len(outputs)} 个索引文件。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
