"""Validate the published knowledge base and provide its shared Markdown parser."""

import json
import os
import re
from bisect import bisect_right
from dataclasses import dataclass
from datetime import date
from pathlib import Path, PurePosixPath
from unicodedata import category
from urllib.parse import unquote, urlsplit

import yaml
from markdown_it import MarkdownIt
from markdown_it.rules_inline import backtick, image, link

ROOT = Path(__file__).resolve().parents[1]
SECTIONS = {
    "project": ("projects", "项目"),
    "topic": ("topics", "技术专题"),
    "adr": ("adr", "架构决策"),
    "troubleshooting": ("troubleshooting", "排障"),
    "synthesis": ("synthesis", "复盘"),
}
OUTPUT_KEYS = {"adr": "adrs"}
RELATED_TYPES = {"related_projects": "project", "related_topics": "topic", "related_adrs": "adr"}
FIELDS = {
    "project": (
        "repo", "repo_url", "visibility", "publish_policy", "tier", "status", "domains",
        "tech_stack", "primary_language", "stars", "synced_commit", "featured",
        "related_topics", "related_adrs",
    ),
    "topic": ("domain", "related_projects"),
    "adr": ("adr_id", "decision_status", "related_projects"),
    "troubleshooting": ("ts_id", "severity", "related_projects"),
    "synthesis": ("related_projects", "related_topics"),
}
COMMON = ("title", "description", "type", "id", "tags", "created", "updated", "draft")
VISUAL_FIELDS = {
    "project": ("mcu", "signal_flow", "highlights"),
    "troubleshooting": ("phases", "root_cause", "located_by"),
}
VISUAL_STEP_MAX_LENGTH = 16
TROUBLESHOOTING_SECTIONS = ("错误原因与触发机理", "定位过程与关键证据", "具体排查流程")
MARKDOWN = MarkdownIt("commonmark")
READING_TRACKS_PATH = "wiki/reading_tracks.yaml"
BACKDROP_PRESETS_PATH = "wiki/backdrop_presets.yaml"
BACKDROP_PRESETS = {"blueprint", "vellum", "aurora"}
BACKDROP_MOTIFS = {"atlas", "control", "bus", "network", "rtos", "ledger", "probe", "index"}
BACKDROP_TONES = {"sky", "mint", "amber", "rose", "violet", "teal"}
ENUMS = {
    "visibility": {"public", "private"},
    "publish_policy": {"public", "sanitized"},
    "tier": {"core", "active", "archive"},
    "status": {"active", "maintained", "archived", "experimental"},
    "decision_status": {"proposed", "accepted", "deprecated", "superseded"},
    "severity": {"low", "medium", "high"},
    "backdrop_motif": BACKDROP_MOTIFS,
    "backdrop_tone": BACKDROP_TONES,
}
SLUG = r"[a-z0-9]+(?:-[a-z0-9]+)*"
SHA = re.compile(r"[0-9a-f]{40}", re.I)
NOTES = re.compile(r"<!-- HUMAN-NOTES:START -->(.*?)<!-- HUMAN-NOTES:END -->", re.S)
COMMENT = re.compile(r"<!--.*?-->", re.S)
FENCE_LANGUAGE = re.compile(r"[A-Za-z0-9_][A-Za-z0-9_.+#-]*")
CALLOUT = re.compile(r"^\[![\w-]+\][+-]?(?P<title>.*)$")
WIKILINK = re.compile(r"(?P<embed>!)?\[\[(?P<target>[^]\n|]+)(?P<label>\|[^\n]+?)?\]\](?!\])")
SOURCE_LINK = re.compile(
    r"https://github\.com/(?P<repo>[\w-]+/[\w.-]+)/(?P<kind>blob|tree)/"
    r"(?P<ref>[^/\s<>()\[\]`\"'?#、，。；：！？]+)"
    r"(?:/(?P<path>(?:\\[()]|\([^()\s<>]*\)|[^()\s<>\[\]`\"'?#、，。；：！？])*))?"
    r"(?:#[^\s<>()\[\]`\"'\\、，。；：！？]+)?",
    re.I,
)
MERMAID_TYPE = re.compile(
    r"^(?P<type>flowchart|graph|sequenceDiagram|stateDiagram(?:-v2)?|classDiagram|erDiagram|xychart-beta)(?=\s|;|$)"
)
FLOWCHART_DIRECTION = re.compile(r"\s+(TB|TD|BT|RL|LR)(?=\s|;|$)")
QUOTED = r'"(?:\\.|[^"\\])*"'
NODE_LABEL = re.compile(QUOTED + r"|(?<=\w)\[(?P<label>(?:" + QUOTED + r'|[^\]\n"])*)\]')
REGISTRY_FIELDS = ("repo", "repo_url", "visibility", "publish_policy", "tier", "domains", "primary_language", "stars", "synced_commit")
SNAPSHOT_FILES = ("meta.json", "readme.md", "tree.txt")
SECRET_PATTERNS = {
    "GitHub token": re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b"),
    "API key": re.compile(r"\bsk-[A-Za-z0-9_-]{20,}\b"),
    "AWS access key": re.compile(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b"),
    "private key": re.compile(r"-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----"),
}


@dataclass
class Note:
    path: Path
    meta: dict
    body: str

    @property
    def route(self):
        return "/" + self.path.relative_to("wiki").with_suffix("").as_posix().lower() + "/"


def load_yaml(path):
    return yaml.safe_load(path.read_text(encoding="utf-8"))


def read_note(path):
    raw = path.read_text(encoding="utf-8")
    if not raw.startswith("---\n"):
        raise ValueError("缺少 YAML frontmatter")
    header, delimiter, body = raw[4:].partition("\n---\n")
    meta = yaml.safe_load(header)
    if not delimiter or not isinstance(meta, dict):
        raise ValueError("frontmatter 必须是 YAML 映射")
    return Note(path.relative_to(ROOT), meta, body.strip("\n"))


def record_code_span(state, silent):
    start, count = state.pos, len(state.tokens)
    matched = backtick(state, silent)
    if len(state.tokens) > count and state.tokens[-1].type == "code_inline":
        state.tokens[-1].meta["span"] = (start, state.pos)
    return matched


MARKDOWN.inline.ruler.at("backticks", record_code_span)


def line_offsets(lines):
    offsets = [0]
    for line in lines:
        offsets.append(offsets[-1] + len(line) + 1)
    return offsets


def inline_source_positions(token, lines, offsets):
    # Inline content drops quote/list prefixes. Map each line back to its original suffix.
    positions = []
    for index, line in enumerate(token.content.split("\n"), start=token.map[0]):
        part = line.lstrip(" \t")
        prefix = lines[index].rfind(part) - (len(line) - len(part))
        positions.extend(range(offsets[index] + prefix, offsets[index] + prefix + len(line) + 1))
    return positions


def record_resource_destination(rule, tag, marker_offset):
    def parse(state, silent):
        start, count = state.pos, len(state.tokens)
        matched = rule(state, silent)
        if not matched or silent or not state.env.get("resource_destinations"):
            return matched

        label_end = state.md.helpers.parseLinkLabel(state, start + marker_offset, tag == "a")
        if state.src[label_end + 1:label_end + 2] != "(":
            return matched
        pos = label_end + 2
        while pos < state.pos and state.src[pos] in " \t\n":
            pos += 1
        destination = state.md.helpers.parseLinkDestination(state.src, pos, state.pos)
        token = next(token for token in state.tokens[count:] if token.tag == tag)
        if destination.ok and not token.meta.get("label"):
            token.meta["destination_span"] = (pos, destination.pos)
        return matched

    return parse


MARKDOWN.options["store_labels"] = True
MARKDOWN.inline.ruler.at("link", record_resource_destination(link, "a", 0))
MARKDOWN.inline.ruler.at("image", record_resource_destination(image, "img", 1))


def markup_chunks(body):
    """Yield (is_code, source) chunks without normalizing Markdown indentation."""
    lines = body.split("\n")
    offsets = line_offsets(lines)

    end = 0
    for token in MARKDOWN.parse(body):
        if token.type in {"code_block", "fence"}:
            first, last = token.map
            start = offsets[first]
            yield False, body[end:start]
            end = min(len(body), offsets[last])
            yield True, body[start:end]
        elif token.type == "inline":
            spans = [child.meta["span"] for child in token.children if child.type == "code_inline"]
            if not spans:
                continue
            positions = inline_source_positions(token, lines, offsets)
            for start, stop in spans:
                yield False, body[end:positions[start]]
                end = positions[stop - 1] + 1
                yield True, body[positions[start]:end]
    yield False, body[end:]


def mask_markup(text):
    return re.sub(r"[^\n]", " ", text)


def visible_markup(body):
    return "".join(
        mask_markup(chunk) if is_code else COMMENT.sub(lambda match: mask_markup(match[0]), chunk)
        for is_code, chunk in markup_chunks(body)
    )


def wikilinks(body):
    return WIKILINK.finditer(visible_markup(body))


def source_links(body):
    return SOURCE_LINK.finditer(visible_markup(body))


def mermaid_fences(tokens):
    for token in tokens:
        if token.type == "fence" and token.level == 0 and token.info.split()[:1] == ["mermaid"]:
            yield token


def mermaid_blocks(body):
    for token in mermaid_fences(MARKDOWN.parse(body)):
        yield token.content


def markdown_inline_text(tokens):
    parts = []
    for token in tokens:
        if token.type in {"text", "code_inline"}:
            parts.append(token.content)
        elif token.type in {"softbreak", "hardbreak"}:
            parts.append("\n")
    return "".join(parts).strip()


def extract_headings(body, tokens=None):
    if tokens is None:
        tokens = MARKDOWN.parse(body)
    headings = []
    used_slugs = set()
    for heading, inline in zip(tokens, tokens[1:]):
        if heading.type != "heading_open":
            continue
        title = WIKILINK.sub(
            lambda match: (match["label"] or "|" + match["target"])[1:], markdown_inline_text(inline.children),
        )
        # Match the slugger used by Astro, including spaces around removed punctuation.
        base = "".join(
            char for char in title.lower()
            if char in " -" or category(char)[0] in "LM" or category(char) in {"Nd", "Nl", "Pc"}
        ).replace(" ", "-")
        slug = base
        suffix = 0
        while slug in used_slugs:
            suffix += 1
            slug = f"{base}-{suffix}"
        used_slugs.add(slug)
        if heading.level == 0 and heading.tag in {"h2", "h3"} and title:
            headings.append((heading.map[0], title, slug))
    return headings


def section_at(headings, line):
    for heading_line, title, slug in reversed(headings):
        if heading_line <= line:
            return title, slug
    return "", ""


def markdown_link_labels(tokens, lines, offsets):
    labels = {}
    for token in tokens:
        if token.type != "inline":
            continue
        positions = None
        for index, child in enumerate(token.children):
            span = child.meta.get("destination_span")
            if child.type != "link_open" or span is None:
                continue
            if positions is None:
                positions = inline_source_positions(token, lines, offsets)
            start = span[0]
            if token.content[start] == "<":
                start += 1
            label_tokens = []
            for label_token in token.children[index + 1:]:
                if label_token.type == "link_close":
                    break
                label_tokens.append(label_token)
            labels[positions[start]] = markdown_inline_text(label_tokens)
    return labels


def unescape_source_path(path):
    return path.replace(r"\(", "(").replace(r"\)", ")")


def extract_evidence_links(note, registered_repos):
    lines = note.body.split("\n")
    offsets = line_offsets(lines)
    tokens = MARKDOWN.parse(note.body, {"resource_destinations": True})
    headings = extract_headings(note.body, tokens)
    labels = markdown_link_labels(tokens, lines, offsets)
    entries = []
    for link in source_links(note.body):
        if not SHA.fullmatch(link["ref"]):
            continue
        repo = link["repo"]
        path = unquote(unescape_source_path(link["path"] or ""))
        section, slug = section_at(headings, bisect_right(offsets, link.start()) - 1)
        entry = {
            "url": unescape_source_path(link[0]), "repo": repo, "kind": link["kind"].lower(),
            "commit": link["ref"], "path": path,
            "label": labels.get(link.start()) or PurePosixPath(path).name or repo, "section": section,
        }
        if repo.casefold() in registered_repos:
            entry["project_id"] = registered_repos[repo.casefold()]
        if slug:
            entry["section_slug"] = slug
        entries.append(entry)
    return entries


def mermaid_content_lines(code):
    return [line for line in map(str.strip, code.splitlines()) if line and not line.startswith("%%")]


def extract_diagrams(note):
    tokens = MARKDOWN.parse(note.body)
    headings = extract_headings(note.body, tokens)
    diagrams = []
    for index, token in enumerate(mermaid_fences(tokens), start=1):
        source = token.content.strip()
        first_line = next(iter(mermaid_content_lines(source)), "")
        header = MERMAID_TYPE.match(first_line)
        diagram_type = "diagram"
        if header:
            diagram_type = header["type"]
        if diagram_type == "graph":
            diagram_type = "flowchart"
        section, slug = section_at(headings, token.map[0])
        diagram = {"index": index, "diagram_type": diagram_type, "title": section or note.meta["title"], "source": source}
        if diagram_type == "flowchart":
            direction = FLOWCHART_DIRECTION.match(first_line, header.end())
            if direction:
                diagram["direction"] = direction[1]
        if slug:
            diagram["section_slug"] = slug
        diagrams.append(diagram)
    return diagrams


def secret_hits(content):
    for label, pattern in SECRET_PATTERNS.items():
        for match in pattern.finditer(content):
            yield label, content.count("\n", 0, match.start()) + 1


def redact_secrets(message):
    for pattern in SECRET_PATTERNS.values():
        message = pattern.sub("[已隐藏]", message)
    return message


def is_text(value):
    return isinstance(value, str) and bool(value.strip()) and value.splitlines() == [value]


def has_text_fields(value, *keys):
    return isinstance(value, dict) and value.keys() == set(keys) and all(is_text(value[key]) for key in keys)


def check_fields(note):
    meta = note.meta
    kind = meta.get("type")
    if not isinstance(kind, str) or kind not in SECTIONS:
        yield "type 未知"
        return
    for key in set(COMMON + FIELDS[kind]) - meta.keys():
        yield f"缺少字段 {key}"
    stem = note.path.stem
    name_pattern = {"adr": r"ADR-\d{4}-", "troubleshooting": r"TS-\d{4}-"}.get(kind, "")
    if meta.get("id") != stem or not re.fullmatch(name_pattern + SLUG, stem):
        yield "id 必须等于文件名并符合命名规则"
    if note.path.parts[1] != SECTIONS[kind][0]:
        yield "type 与页面目录不符"
    if kind == "topic" and (
        len(note.path.parts) != 4 or meta.get("domain") != note.path.parent.name
        or not re.fullmatch(SLUG, note.path.parent.name)
    ):
        yield "domain 必须等于专题的一级父目录名"
    for key in ("adr_id", "ts_id"):
        if key in FIELDS[kind] and meta.get(key) != "-".join(stem.split("-")[:2]):
            yield f"{key} 必须等于文件名前缀"
    for key in ("draft", "featured"):
        if key in meta and type(meta[key]) is not bool:
            yield f"{key} 必须为布尔值"
    for key in ("title", "description", "repo", "repo_url", "primary_language", "synced_commit", "domain"):
        if key in meta and (not isinstance(meta[key], str) or not meta[key].strip()):
            yield f"{key} 必须是非空字符串"
    if isinstance(meta.get("description"), str) and len(meta["description"]) > 160:
        yield "description 超过 160 字"
    for key in VISUAL_FIELDS.get(kind, ()):
        if key not in meta:
            if kind == "troubleshooting" and meta.get("draft") is False:
                yield f"公开排障页缺少字段 {key}"
            continue
        value = meta[key]
        if key == "mcu":
            if not is_text(value):
                yield "mcu 必须是非空单行字符串"
        elif key == "highlights":
            if not isinstance(value, list) or not 2 <= len(value) <= 4 or any(
                not has_text_fields(item, "label", "value") for item in value
            ):
                yield "highlights 必须含 2–4 项，每项使用非空单行 label 和 value"
        elif key in ("root_cause", "located_by"):
            if not is_text(value):
                yield f"{key} 必须是非空单行字符串"
            elif len(value) > 120:
                yield f"{key} 超过 120 字"
        elif not isinstance(value, list) or not 3 <= len(value) <= 5 or not all(map(is_text, value)):
            yield f"{key} 必须含 3–5 个非空单行字符串"
        else:
            for index, step in enumerate(value, start=1):
                if len(step) > VISUAL_STEP_MAX_LENGTH:
                    yield f"{key} 第 {index} 步超过 {VISUAL_STEP_MAX_LENGTH} 字符"
    valid_dates = {}
    for key in ("created", "updated"):
        value = meta.get(key)
        if isinstance(value, date):
            value = str(value)
            meta[key] = value
        try:
            if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
                raise ValueError
            valid_dates[key] = date.fromisoformat(value)
        except ValueError:
            yield f"{key} 必须为有效的 YYYY-MM-DD"
    if len(valid_dates) == 2 and valid_dates["created"] > valid_dates["updated"]:
        yield "updated 早于 created"
    for key, choices in ENUMS.items():
        if key in meta and (not isinstance(meta[key], str) or meta[key] not in choices):
            yield f"{key} 枚举值非法"
    for key in ("tags", "domains", "tech_stack", *RELATED_TYPES):
        if key not in meta:
            continue
        values = meta[key]
        if not isinstance(values, list) or any(not isinstance(item, str) or not item.strip() for item in values):
            yield f"{key} 必须是字符串数组"
            continue
        limits = {"domains": (1, 3), "tech_stack": (3, 6)}
        low, high = limits.get(key, (0, len(values)))
        if not low <= len(values) <= high or len(set(values)) != len(values):
            yield f"{key} 数组长度或唯一性不符"
    if kind == "project":
        repo = meta.get("repo")
        if not isinstance(repo, str) or not re.fullmatch(r"[\w-]+/[\w.-]+", repo):
            yield "repo 必须为 owner/name"
        elif meta.get("repo_url") != f"https://github.com/{repo}":
            yield "repo_url 与 repo 不对应"
        if type(meta.get("stars")) is not int or meta["stars"] < 0:
            yield "stars 必须为非负整数"
        commit = meta.get("synced_commit")
        if meta.get("draft") is False and (not isinstance(commit, str) or not SHA.fullmatch(commit)):
            yield "公开档案的 synced_commit 必须是 40 位 Git SHA"
        if meta.get("draft") is False and meta.get("visibility") != "public":
            yield "当前公共库只发布公开源仓的档案"
    if len(NOTES.findall(note.body)) != 1 or note.body.count("<!-- HUMAN-NOTES:") != 2:
        yield "须保留一对 HUMAN-NOTES 标记"


def load_notes():
    notes = {}
    errors = []
    for path in sorted((ROOT / "wiki").rglob("*.md")):
        try:
            note = read_note(path)
            errors.extend(f"{note.path}: {error}" for error in check_fields(note))
        except (OSError, UnicodeError, ValueError, yaml.YAMLError) as error:
            errors.append(f"{path.relative_to(ROOT)}: 无法解析页面 ({type(error).__name__})")
            continue
        key = path.stem.casefold()
        if key in notes:
            errors.append(f"{note.path}: basename 重复 ({notes[key].path})")
            continue
        notes[key] = note
    return {note.path.stem: note for note in notes.values()}, errors


def load_reading_tracks(notes):
    path = ROOT / READING_TRACKS_PATH
    try:
        tracks = load_yaml(path)
    except FileNotFoundError:
        return [], []
    except (OSError, UnicodeError, yaml.YAMLError):
        return [], [f"{READING_TRACKS_PATH}: 无法读取阅读路线"]
    if not isinstance(tracks, list):
        return [], [f"{READING_TRACKS_PATH}: 阅读路线必须是数组"]

    ids = set()
    errors = []
    for number, track in enumerate(tracks, start=1):
        prefix = f"{READING_TRACKS_PATH}: 第 {number} 条路线"
        if not isinstance(track, dict) or track.keys() != {"id", "title", "summary", "steps"} or not all(
            is_text(track[key]) for key in ("id", "title", "summary")
        ):
            errors.append(f"{prefix} 必须含 id、title、summary 和 steps")
            continue
        track_id = track["id"]
        if not re.fullmatch(SLUG, track_id) or track_id in ids:
            errors.append(f"{prefix} 的 id 必须为唯一的英文 kebab-case")
        ids.add(track_id)
        steps = track["steps"]
        if not isinstance(steps, list) or not steps:
            errors.append(f"{prefix} 的 steps 必须是非空数组")
            continue
        for index, step in enumerate(steps, start=1):
            if not has_text_fields(step, "id", "role", "focus"):
                errors.append(f"{prefix}第 {index} 步必须含非空单行 id、role 和 focus")
                continue
            ref = step["id"]
            if ref not in notes or notes[ref].meta.get("draft") is not False:
                errors.append(f"{prefix}第 {index} 步引用的页面未发布或不存在 ({ref})")
    return tracks, errors


def load_backdrop_presets():
    try:
        presets = load_yaml(ROOT / BACKDROP_PRESETS_PATH)
    except FileNotFoundError:
        return [], []
    except (OSError, UnicodeError, yaml.YAMLError):
        return [], [f"{BACKDROP_PRESETS_PATH}: 无法读取背景预设"]
    if not isinstance(presets, list):
        return [], [f"{BACKDROP_PRESETS_PATH}: 背景预设必须是数组"]

    required = {"id", "label", "summary"}
    allowed = required | {"default"}
    ids = set()
    defaults = 0
    errors = []
    for number, preset in enumerate(presets, start=1):
        prefix = f"{BACKDROP_PRESETS_PATH}: 第 {number} 项预设"
        if not isinstance(preset, dict) or not required <= preset.keys() <= allowed:
            errors.append(f"{prefix} 必须含 id、label、summary，仅可额外指定 default")
            continue
        preset_id = preset["id"]
        if not isinstance(preset_id, str) or preset_id not in BACKDROP_PRESETS:
            errors.append(f"{prefix} 的 id 枚举值非法")
        elif preset_id in ids:
            errors.append(f"{prefix} 的 id 重复")
        else:
            ids.add(preset_id)
        for key in ("label", "summary"):
            if not is_text(preset[key]):
                errors.append(f"{prefix} 的 {key} 必须是非空单行字符串")
        default = preset.get("default", False)
        if type(default) is not bool:
            errors.append(f"{prefix} 的 default 必须为布尔值")
        elif default:
            defaults += 1
    if defaults != 1:
        errors.append(f"{BACKDROP_PRESETS_PATH}: 必须恰好有一项 default: true")
    return presets, errors


def relative_wiki_asset(note, pathname):
    pathname = unquote(pathname)
    if not pathname or pathname.startswith("/") or "\\" in pathname or "\0" in pathname:
        return None
    assets = ROOT / "wiki" / "assets"
    candidate = Path(os.path.abspath(ROOT / note.path.parent / pathname))
    if not candidate.is_relative_to(assets) or candidate == assets:
        return None
    return candidate


def markdown_images(body):
    for token in MARKDOWN.parse(body):
        if token.type != "inline":
            continue
        for child in token.children:
            if child.type == "image":
                yield child.attrs["src"]


def check_image(note, target):
    parsed = urlsplit(target)
    if parsed.scheme or parsed.netloc:
        return True
    path = relative_wiki_asset(note, parsed.path)
    return path is not None and path.is_file() and path.resolve().as_posix() == path.as_posix()


def resolve_wiki_asset(note, target):
    target = target.split("#", 1)[0]
    wiki = ROOT / "wiki"
    assets = (wiki / "assets").resolve()
    for candidate in (ROOT / note.path.parent / target, wiki / target, assets / target):
        path = candidate.resolve()
        if path.is_relative_to(assets) and path.name != ".gitkeep" and path.is_file():
            return path.relative_to(assets).as_posix()
    if Path(target).name == target and target != ".gitkeep":
        matches = [path for path in assets.rglob("*") if path.name == target and path.is_file()]
        if len(matches) > 1:
            raise ValueError(f"图片名称不唯一，请使用 assets/ 下的完整相对路径 {target}")
        if matches and matches[0].resolve().is_relative_to(assets):
            return matches[0].relative_to(assets).as_posix()
    raise ValueError(f"图片不存在于 wiki/assets {target}")


def check_links(notes):
    errors = []
    topics_used = set()
    for stem, note in notes.items():
        meta = note.meta
        references = []
        for match in wikilinks(note.body):
            if match["embed"]:
                try:
                    resolve_wiki_asset(note, match["target"])
                except ValueError as error:
                    errors.append(f"{note.path}: {error}")
                continue
            target = match["target"].split("#", 1)[0]
            if not target or match["label"] is None or "#" in match["target"] or "/" in target:
                errors.append(f"{note.path}: 使用 [[id|显示文本]] 链接页面 ({match['target']})")
            references.append((target, None))
        for target in markdown_images(note.body):
            if not check_image(note, target):
                errors.append(f"{note.path}: 本地图片必须是 wiki/assets 下存在的文件 {target}")
        for key, kind in RELATED_TYPES.items():
            if isinstance(meta.get(key), list):
                references.extend((target, kind) for target in meta[key] if isinstance(target, str))
        for target, kind in references:
            other = notes.get(target)
            if other is None or (kind and other.meta.get("type") != kind):
                errors.append(f"{note.path}: 引用目标不存在或类型不符 {target}")
                continue
            if meta.get("draft") is False and other.meta.get("draft") is True:
                errors.append(f"{note.path}: 公开页面引用草稿 {target}")
            if meta.get("draft") is False and other.meta.get("draft") is False:
                reverse_field = None
                if meta.get("type") == "project" and kind in {"topic", "adr"}:
                    reverse_field = "related_projects"
                if meta.get("type") in {"topic", "adr"} and kind == "project":
                    reverse_field = f"related_{meta['type']}s"
                if reverse_field:
                    reverse = other.meta.get(reverse_field)
                    if not isinstance(reverse, list) or stem not in reverse:
                        errors.append(f"{note.path}: {other.path} 的 {reverse_field} 缺少反向关联 {stem}")
            if meta.get("type") == "project" and other.meta.get("type") == "topic":
                topics_used.add(target)
            if meta.get("type") == "topic" and other.meta.get("type") == "project":
                topics_used.add(stem)
    warnings = [
        f"{note.path}: 孤儿专题，尚未与项目关联"
        for stem, note in notes.items() if note.meta.get("type") == "topic" and stem not in topics_used
    ]
    return errors, warnings


def snapshot_inventory_errors(repos):
    root = ROOT / "raw" / "snapshots"
    if not root.exists():
        return
    for directory in sorted(root.iterdir()):
        if not directory.is_dir():
            continue
        relative = directory.relative_to(ROOT)
        item = repos.get(directory.name)
        if item is None:
            yield f"{relative}: 快照目录未登记在 registry.yaml"
            continue
        snapshot = item.get("snapshot_commit")
        if not isinstance(snapshot, str) or not SHA.fullmatch(snapshot):
            yield f"{relative}: 快照目录必须登记有效的 40 位 snapshot_commit"


def check_registry(notes, repos):
    errors = list(snapshot_inventory_errors(repos))
    trees = {}
    for stem, note in notes.items():
        if note.meta.get("type") != "project" or note.meta.get("draft") is not False:
            continue
        item = repos.get(stem)
        if item is None:
            errors.append(f"{note.path}: 项目未登记在 registry.yaml")
            continue
        snapshot = item.get("snapshot_commit")
        if not isinstance(snapshot, str) or not SHA.fullmatch(snapshot):
            errors.append(f"{note.path}: 公开档案的 snapshot_commit 必须是 40 位 Git SHA")
        for field in REGISTRY_FIELDS:
            if field not in item or note.meta.get(field) != item[field]:
                errors.append(f"{note.path}: {field} 与 registry.yaml 不一致")

    for key, item in repos.items():
        snapshot = item.get("snapshot_commit")
        synced = item.get("synced_commit")
        directory = ROOT / "raw" / "snapshots" / key
        relative = directory.relative_to(ROOT)
        note = notes.get(key)
        if item.get("available") is not True or item.get("visibility") != "public":
            if note is not None and note.meta.get("type") == "project" and note.meta.get("draft") is False:
                errors.append(f"{note.path}: {item['repo']} 已不在公开清单，请复核公开项目档案")
            if snapshot or directory.exists():
                errors.append(f"{relative}: {item['repo']} 已不在公开清单，请复核快照及 registry.yaml 的 snapshot_commit")
            continue
        if item.get("tier") in {"core", "active"} and synced:
            if note is None or note.meta.get("draft") is not False or note.meta.get("type") != "project":
                errors.append(f"registry.yaml: {key} 缺少对应的公开项目档案")
        if not snapshot:
            continue
        for name in SNAPSHOT_FILES:
            if not (directory / name).is_file():
                errors.append(f"{relative / name}: 缺少快照文件")
        meta_path = directory / "meta.json"
        if meta_path.is_file():
            try:
                meta = json.loads(meta_path.read_text(encoding="utf-8"))
                if not isinstance(meta, dict) or meta.get("commit") != snapshot:
                    errors.append(f"{relative / 'meta.json'}: commit 与 snapshot_commit 不一致")
            except (OSError, ValueError):
                errors.append(f"{relative / 'meta.json'}: 无法读取快照元数据")
        tree_path = directory / "tree.txt"
        if synced == snapshot and tree_path.is_file():
            try:
                paths = set(tree_path.read_text(encoding="utf-8").splitlines())
                directories = {parent.as_posix() for path in paths for parent in PurePosixPath(path).parents}
                trees[key] = (paths - directories, directories - {"."})
            except (OSError, UnicodeError):
                errors.append(f"{relative / 'tree.txt'}: 无法读取快照目录树")
    return errors, trees


def check_source_links(note, registered, trees):
    for link in source_links(note.body):
        entry = registered.get(link["repo"].casefold())
        if entry is None:
            continue
        key, commit = entry
        ref = link["ref"]
        if not SHA.fullmatch(ref):
            yield f"{note.path}: GitHub 源码链接必须固定 40 位 SHA ({link[0]})"
        elif not isinstance(commit, str) or ref.lower() != commit.lower():
            yield f"{note.path}: GitHub 源码链接与 {key} 的 synced_commit 不一致 ({link[0]})"
        elif key in trees:
            path = unquote(unescape_source_path(link["path"] or ""))
            files, directories = trees[key]
            if link["kind"].lower() == "blob":
                exists = path in files
            else:
                exists = not path or path.removesuffix("/") in directories
            if not exists:
                yield f"{note.path}: GitHub 源码链接在快照目录树中不存在 ({link[0]})"


def check_mermaid(note):
    for number, code in enumerate(mermaid_blocks(note.body), start=1):
        lines = mermaid_content_lines(code)
        prefix = f"{note.path}: Mermaid 第 {number} 块"
        if not lines or not MERMAID_TYPE.match(lines[0]):
            yield f"{prefix}为空或图类型不受支持"
        elif re.match(r"^(?:flowchart|graph)\b", lines[0]):
            for line in lines:
                for match in NODE_LABEL.finditer(line):
                    label = match["label"]
                    if label is None:
                        continue
                    if label.startswith("(") and label.endswith(")"):
                        label = label[1:-1]
                    label = label.removeprefix("[").strip()
                    if ("(" in label or ")" in label) and not re.fullmatch(QUOTED, label):
                        yield f"{prefix}含括号的节点标签必须使用双引号 ({label})"


def check_markdown_format(note):
    tokens = MARKDOWN.parse(note.body)
    for token in tokens:
        if token.type == "fence" and token.content.strip():
            language = token.info.strip().split(maxsplit=1)
            if not language or not FENCE_LANGUAGE.fullmatch(language[0]):
                yield f"{note.path}: 正文第 {token.map[0] + 1} 行代码块缺少语言标识"

    if note.meta.get("draft") is not False:
        return
    for quote, block, inline in zip(tokens, tokens[1:], tokens[2:]):
        if quote.type != "blockquote_open" or inline.type != "inline":
            continue
        if block.type != "paragraph_open" and block.markup not in ("-", "="):
            continue
        callout = CALLOUT.fullmatch(inline.content.partition("\n")[0])
        if callout and not COMMENT.sub("", callout["title"]).strip():
            yield f"{note.path}: 正文第 {inline.map[0] + 1} 行 Callout 缺少标题"


def check_troubleshooting_sections(note):
    if note.meta.get("type") != "troubleshooting" or note.meta.get("draft") is not False:
        return
    tokens = MARKDOWN.parse(NOTES.sub("    ", note.body))
    headings = {
        content.content for heading, content in zip(tokens, tokens[1:])
        if heading.type == "heading_open" and heading.tag == "h2" and heading.level == 0
    }
    for heading in TROUBLESHOOTING_SECTIONS:
        if heading not in headings:
            yield f"{note.path}: 公开排障页缺少二级标题「{heading}」"


def check_content(notes, registry):
    errors, warnings = check_links(notes)
    repos = registry["repos"]
    registry_errors, trees = check_registry(notes, repos)
    errors.extend(registry_errors)
    registered = {item["repo"].casefold(): (key, item.get("synced_commit")) for key, item in repos.items()}
    for note in notes.values():
        errors.extend(check_source_links(note, registered, trees))
        errors.extend(check_mermaid(note))
        errors.extend(check_markdown_format(note))
        errors.extend(check_troubleshooting_sections(note))
    return errors, warnings


def scan_secrets():
    excluded = {".git", ".venv", ".uv-cache", "__pycache__", "dist", "node_modules"}
    generated_paths = {ROOT / "apps/portal" / path for path in ("src/content/docs", ".astro", "public/wiki-assets")}
    lock_files = {"pnpm-lock.yaml", "uv.lock"}
    text_extensions = {
        ".md", ".txt", ".json", ".yaml", ".yml", ".py", ".toml", ".lock", ".svg",
        ".ini", ".cfg", ".html", ".css", ".js", ".mjs", ".jsx", ".ts", ".tsx",
        ".astro", ".svelte", ".vue", ".sh", ".ps1",
    }
    for folder, directories, filenames in os.walk(ROOT):
        parent = Path(folder)
        directories[:] = [name for name in directories if name not in excluded and parent / name not in generated_paths]
        for name in filenames:
            if name in lock_files:
                continue
            path = parent / name
            if path.suffix.lower() not in text_extensions and name not in {".env", ".gitignore"} and not name.startswith(".env."):
                continue
            if not path.resolve().is_relative_to(ROOT):
                continue
            try:
                content = path.read_text(encoding="utf-8-sig")
            except (OSError, UnicodeError):
                yield f"{path.relative_to(ROOT)}: 无法读取文本"
                continue
            for label, line in secret_hits(content):
                yield f"{path.relative_to(ROOT)}:{line}: 疑似凭据 ({label})"


def main():
    notes, errors = load_notes()
    registry = load_yaml(ROOT / "registry.yaml")
    content_errors, warnings = check_content(notes, registry)
    errors.extend(content_errors)
    _, route_errors = load_reading_tracks(notes)
    errors.extend(route_errors)
    _, backdrop_errors = load_backdrop_presets()
    errors.extend(backdrop_errors)
    errors.extend(scan_secrets())
    for warning in warnings:
        print(f"WARNING {redact_secrets(warning)}")
    for error in errors:
        print(f"ERROR {redact_secrets(error)}")
    print(f"检查 {len(notes)} 页，{len(errors)} 个错误，{len(warnings)} 个提醒。")
    return int(bool(errors))


if __name__ == "__main__":
    raise SystemExit(main())
