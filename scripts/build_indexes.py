"""Build the public JSON catalog, relationship graph and reading indexes."""

import argparse
import json
import re
import sys
from collections import Counter, defaultdict
from datetime import date, datetime, timezone
from urllib.parse import quote, urlsplit

from lint_kb import (
    COMMENT, COMMON, FIELDS, MARKDOWN, NOTES, OUTPUT_KEYS, RELATED_TYPES, ROOT, SECTIONS, WIKILINK,
    VISUAL_FIELDS, check_content, check_registry, extract_diagrams, extract_evidence_links, inline_source_positions,
    line_offsets, load_backdrop_presets, load_notes, load_reading_tracks, load_source_anchors, load_yaml, markup_chunks, redact_secrets,
    relative_wiki_asset, resolve_wiki_asset, visible_markup, wikilinks,
)

JSON_PATHS = ["data/catalog.json", "data/graph.json", "data/stats.json"]
RECENT_TYPE_ORDER = ("troubleshooting", "adr", "topic", "synthesis", "project")
EMPTY_REVIEW_LINES = re.compile(r"(?m)^[ \t]*(?:##[ \t]+个人复盘与后续思考|（由人工补充与维护）)[ \t]*$")
INLINE_MARKUP = re.compile(
    r"!?\[(?P<label>(?:[^\[\]\n]|\[[^\[\]\n]*\])*)\]\(\s*"
    r'(?:<[^>\n]*>|(?:\\.|[^()\s\\]|\([^()\n]*\))*)'
    r'''(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^()\n]*\)))?[ \t]*\)'''
)
TABLE_SEPARATOR = re.compile(r"\|?\s*:?-+:?(?:\s*\|\s*:?-+:?)*\s*\|?")
REFERENCE_LABEL = re.compile(r"\[(?:\\.|[^\\\[\]])+]:[ \t]*(?:\n[ \t>]*)?", re.S)
LABEL_ESCAPE = re.compile(r"([\\\[\]])")


def json_text(data):
    return json.dumps(data, ensure_ascii=False, indent=2) + "\n"


def has_human_notes(text):
    return any(EMPTY_REVIEW_LINES.sub("", COMMENT.sub("", block)).strip() for block in NOTES.findall(text))


def clean_chunks(text):
    keep_human_notes = has_human_notes(text)
    for is_code, chunk in markup_chunks(text):
        if is_code:
            yield True, chunk
        else:
            if not keep_human_notes:
                chunk = NOTES.sub("", chunk)
            yield False, COMMENT.sub("", chunk)


def trim_blank_lines(text):
    return re.sub(r"^(?:[ \t]*\n)*", "", text).rstrip("\n")


def clean_body(text):
    return trim_blank_lines("".join(chunk for _, chunk in clean_chunks(text)))


def word_count(text):
    chunks = list(clean_chunks(text))
    body = "".join(chunk for _, chunk in chunks)
    # Keep code in link labels while ignoring Markdown examples inside code.
    markup = "".join(re.sub(r"[^\n]", "~", chunk) if is_code else chunk for is_code, chunk in chunks)
    parts = []
    end = 0
    for match in INLINE_MARKUP.finditer(markup):
        start, stop = match.span("label")
        parts.extend((body[end:match.start()], body[start:stop]))
        end = match.end()
    parts.append(body[end:])
    text = "".join(parts)
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


def resolve_page_backdrop(meta):
    kind = meta["type"]
    if kind == "project":
        project_id = meta["id"].lower()
        domains = [domain.lower() for domain in meta["domains"]]
        stack = " ".join(meta["tech_stack"]).lower()
        # Match the portal's JavaScript word boundaries for lwIP and CAN.
        if "networking" in domains or project_id == "iwip" or re.search(r"\blwip\b|ethernet|rmii", stack, re.ASCII):
            motif, tone = "network", "teal"
        elif project_id == "bootloader" or re.search(r"\bcan\b|w25q|eeprom|bootloader", stack, re.ASCII):
            motif, tone = "bus", "amber"
        elif project_id in {"flight", "mspm0g3507"} or re.search(r"mpu6050|k230|pid", stack):
            motif, tone = "control", "sky"
        else:
            motif, tone = "rtos", "mint"
    elif kind == "topic" and meta["domain"] == "networking":
        motif, tone = "network", "teal"
    else:
        motif, tone = {
            "topic": ("index", "mint"),
            "adr": ("ledger", "amber"),
            "troubleshooting": ("probe", "rose"),
            "synthesis": ("atlas", "violet"),
        }[kind]
    return {"motif": meta.get("backdrop_motif", motif), "tone": meta.get("backdrop_tone", tone)}


def build_data(notes, owner, reading_tracks=(), backdrop_presets=(), source_anchors=()):
    keys = {kind: OUTPUT_KEYS.get(kind, directory) for kind, (directory, _) in SECTIONS.items()}
    catalog = {"owner": owner, **{key: [] for key in keys.values()}, "link_map": {}}
    if reading_tracks:
        catalog["reading_tracks"] = reading_tracks
    if backdrop_presets:
        catalog["backdrop_presets"] = backdrop_presets
    if source_anchors:
        catalog["source_anchors"] = source_anchors
    repo_names = {}
    project_ids = {}
    for note in notes.values():
        if (note.meta["type"] == "project" and note.meta["draft"] is False
                and note.meta["visibility"] == "public" and note.meta["publish_policy"] == "public"):
            repo = note.meta["repo"]
            repo_names[repo.casefold()] = repo
            project_ids[repo.casefold()] = note.meta["id"]
    evidence_files = defaultdict(list)
    diagram_counts = Counter()
    edges = set()
    for note in notes.values():
        meta = note.meta
        source = meta["id"]
        kind = meta["type"]
        item = {key: meta[key] for key in COMMON + FIELDS[kind] if key != "draft"}
        item.update({key: meta[key] for key in VISUAL_FIELDS.get(kind, ()) if key in meta})
        words = word_count(note.body)
        evidence = extract_evidence_links(note, project_ids)
        diagrams = extract_diagrams(note)
        for link in evidence:
            repo = repo_names.setdefault(link["repo"].casefold(), link["repo"])
            evidence_files[repo].append((link["commit"].lower(), link["path"]))
        diagram_counts.update(diagram["diagram_type"] for diagram in diagrams)
        item.update(
            route=note.route, source_path=note.path.as_posix(), word_count=words,
            reading_minutes=max(1, round(words / 350)),
            mermaid_count=len(diagrams),
            table_count=table_count(note.body),
            evidence_count=len(evidence),
            has_human_notes=has_human_notes(note.body),
            evidence_links=evidence,
            diagrams=diagrams,
            backdrop=resolve_page_backdrop(meta),
        )
        catalog[keys[kind]].append(item)
        catalog["link_map"][source] = note.route
        for match in wikilinks(note.body):
            target = match["target"]
            if match["embed"]:
                item.setdefault("assets", {})[target] = resolve_wiki_asset(note, target)
                continue
            edges.add((source, target, "wikilink"))
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
            "unique_evidence_files": sum(len(set(files)) for files in evidence_files.values()),
            "total_source_anchors": len(source_anchors),
            "total_source_lines": sum(anchor["end_line"] - anchor["start_line"] + 1 for anchor in source_anchors),
        },
        "by_tier": {tier: tier_counts[tier] for tier in ("core", "active", "archive")},
        "by_domain": dict(sorted(Counter(domain for item in projects for domain in item["domains"]).items())),
        "by_tech_stack": dict(sorted(Counter(tech for item in projects for tech in item["tech_stack"]).items())),
        "by_language": dict(sorted(Counter(item["primary_language"] for item in projects).items())),
        "by_evidence_repo": {
            repo: {"project_id": project_ids[repo.casefold()], "count": len(files), "unique_files": len(set(files))}
            for repo, files in sorted(evidence_files.items())
        },
        "by_diagram_type": dict(sorted(diagram_counts.items())),
        "by_anchor_category": dict(sorted(Counter(anchor["category"] for anchor in source_anchors).items())),
        "by_backdrop_motif": dict(sorted(Counter(item["backdrop"]["motif"] for item in items).items())),
        "recent_updates": [
            {key: item[key] for key in ("id", "title", "type", "updated", "route", "description")}
            for item in sorted(items, key=recent_update_key)[:12]
        ],
    }
    return catalog, graph, stats


def public_link(note):
    return "." + note.route


def resource_spans(body):
    env = {"resource_destinations": True}
    lines = body.split("\n")
    offsets = line_offsets(lines)
    used_references = set()
    for token in MARKDOWN.parse(body, env):
        if token.type != "inline":
            continue
        positions = None
        for child in token.children:
            if child.type not in {"link_open", "image"}:
                continue
            if "label" in child.meta:
                used_references.add(child.meta["label"])
            if "destination_span" not in child.meta:
                continue
            if positions is None:
                positions = inline_source_positions(token, lines, offsets)
            start, end = child.meta["destination_span"]
            target = child.attrs.get("src", child.attrs.get("href", ""))
            yield positions[start], positions[end - 1] + 1, target

    for label in used_references:
        reference = env["references"][label]
        first, last = reference["map"]
        source = body[offsets[first]:offsets[last]]
        match = REFERENCE_LABEL.search(source)
        if match is None:
            continue
        destination = MARKDOWN.helpers.parseLinkDestination(source, match.end(), len(source))
        if destination.ok and MARKDOWN.normalizeLink(destination.str) == reference["href"]:
            yield offsets[first] + match.end(), offsets[first] + destination.pos, reference["href"]


def rebase_corpus_assets(note, body):
    parts = []
    cursor = 0
    for start, end, target in sorted(resource_spans(body)):
        parsed = urlsplit(target)
        if parsed.scheme or parsed.netloc:
            continue
        path = relative_wiki_asset(note, parsed.path)
        if path is None:
            continue
        relative = path.relative_to(ROOT / "wiki" / "assets").as_posix()
        suffix = target[len(parsed.path):].replace("&", "&amp;")
        parts.extend((body[cursor:start], f"<./wiki-assets/{quote(relative)}{suffix}>"))
        cursor = end
    parts.append(body[cursor:])
    return "".join(parts)


def corpus_body(note, notes):
    def render(match):
        target = notes.get(match["target"])
        label = (match["label"] or "|" + match["target"])[1:]
        if target is None or match["embed"]:
            return label
        label = LABEL_ESCAPE.sub(r"\\\1", label)
        return f"[{label}]({public_link(target)})"

    body = trim_blank_lines("".join(
        chunk if is_code else WIKILINK.sub(render, chunk) for is_code, chunk in clean_chunks(note.body)
    ))
    return rebase_corpus_assets(note, body)


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
    registry_check = check_registry(notes, registry["repos"])
    content_errors, _ = check_content(notes, registry, registry_check)
    errors.extend(content_errors)
    reading_tracks, route_errors = load_reading_tracks(notes)
    errors.extend(route_errors)
    backdrop_presets, backdrop_errors = load_backdrop_presets()
    errors.extend(backdrop_errors)
    source_anchors, anchor_errors = load_source_anchors(notes, registry["repos"], registry_check[1])
    errors.extend(anchor_errors)
    if errors:
        for error in errors:
            print(f"ERROR {redact_secrets(error)}", file=sys.stderr)
        return 1
    notes = {key: notes[key] for key in sorted(notes) if notes[key].meta["draft"] is False}
    payloads = build_data(notes, registry["owner"], reading_tracks, backdrop_presets, source_anchors)
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
