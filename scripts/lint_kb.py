"""Validate the published knowledge base and provide its shared Markdown parser."""

import json
import os
import re
from dataclasses import dataclass
from datetime import date
from pathlib import Path, PurePosixPath
from urllib.parse import unquote, urlsplit

import yaml

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
    "troubleshooting": ("phases",),
}
READING_TRACKS_PATH = "wiki/reading_tracks.yaml"
ENUMS = {
    "visibility": {"public", "private"},
    "publish_policy": {"public", "sanitized"},
    "tier": {"core", "active", "archive"},
    "status": {"active", "maintained", "archived", "experimental"},
    "decision_status": {"proposed", "accepted", "deprecated", "superseded"},
    "severity": {"low", "medium", "high"},
}
SLUG = r"[a-z0-9]+(?:-[a-z0-9]+)*"
SHA = re.compile(r"[0-9a-f]{40}", re.I)
NOTES = re.compile(r"<!-- HUMAN-NOTES:START -->(.*?)<!-- HUMAN-NOTES:END -->", re.S)
COMMENT = re.compile(r"<!--.*?-->", re.S)
BLOCKS = re.compile(
    COMMENT.pattern + r"|^ {0,3}(?P<fence>(?P<marker>[`~])(?P=marker){2,})"
    r"(?P<info>[^\n]*)\n(?P<code>.*?)(?:^ {0,3}(?P=fence)(?P=marker)*[ \t]*$|\Z)",
    re.M | re.S,
)
INLINE_CODE = re.compile(r"(?<!`)(?P<ticks>`+)(?!`)[^\n]+?(?<!`)(?P=ticks)(?!`)")
WIKILINK = re.compile(r"(?P<embed>!)?\[\[(?P<target>[^]\n|]+)(?P<label>\|[^]\n]+)?\]\]")
IMAGE = re.compile(r'!\[[^]\n]*\]\(\s*(?:<([^>\n]+)>|((?:\\[()]|[^()\s]|\([^()\n]*\))+))(?=\s|\))')
SOURCE_LINK = re.compile(
    r"https://github\.com/(?P<repo>[\w-]+/[\w.-]+)/(?P<kind>blob|tree)/"
    r"(?P<ref>[^/\s<>()\[\]`\"'?#、，。；：！？]+)"
    r"(?:/(?P<path>(?:\\[()]|\([^()\s<>]*\)|[^()\s<>\[\]`\"'?#、，。；：！？])*))?",
    re.I,
)
MERMAID_TYPE = re.compile(
    r"^(?:flowchart|graph|sequenceDiagram|stateDiagram(?:-v2)?|classDiagram|erDiagram|xychart-beta)(?=\s|;|$)"
)
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
        return "/" + self.path.relative_to("wiki").with_suffix("").as_posix() + "/"


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
    return Note(path.relative_to(ROOT), meta, body.strip())


def visible_markup(body):
    return INLINE_CODE.sub("", BLOCKS.sub("\n", body))


def wikilinks(body):
    return WIKILINK.finditer(visible_markup(body))


def source_links(body):
    return SOURCE_LINK.finditer(visible_markup(body))


def mermaid_blocks(body):
    for block in BLOCKS.finditer(body):
        if block["info"] is not None and block["info"].strip().split()[:1] == ["mermaid"]:
            yield block["code"]


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
        elif not isinstance(value, list) or not 3 <= len(value) <= 5 or not all(map(is_text, value)):
            yield f"{key} 必须含 3–5 个非空单行字符串"
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


def check_image(note, target):
    parsed = urlsplit(target.replace("\\(", "(").replace("\\)", ")"))
    if parsed.scheme or parsed.netloc:
        return True
    path = (ROOT / note.path.parent / unquote(parsed.path)).resolve()
    return path.is_relative_to(ROOT / "wiki") and path.is_file()


def check_links(notes):
    errors = []
    topics_used = set()
    for stem, note in notes.items():
        meta = note.meta
        references = []
        for match in wikilinks(note.body):
            target = match["target"].split("#", 1)[0]
            if match["embed"] and Path(target).suffix:
                candidates = [ROOT / note.path.parent / target, ROOT / "wiki" / target]
                if "/" not in target:
                    candidates.extend((ROOT / "wiki" / "assets").rglob(target))
                if not any(path.resolve().is_relative_to(ROOT / "wiki") and path.is_file() for path in candidates):
                    errors.append(f"{note.path}: 图片不存在 {target}")
                continue
            if not target or match["label"] is None or "#" in match["target"] or "/" in target:
                errors.append(f"{note.path}: 使用 [[id|显示文本]] 链接页面 ({match['target']})")
            references.append((target, None))
        for a, b in IMAGE.findall(visible_markup(note.body)):
            target = a or b
            if not check_image(note, target):
                errors.append(f"{note.path}: 图片不存在 {target}")
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


def check_registry(notes, repos):
    errors = []
    trees = {}
    for stem, note in notes.items():
        if note.meta.get("type") != "project" or note.meta.get("draft") is not False:
            continue
        item = repos.get(stem)
        if item is None:
            errors.append(f"{note.path}: 项目未登记在 registry.yaml")
            continue
        for field in REGISTRY_FIELDS:
            if field not in item or note.meta.get(field) != item[field]:
                errors.append(f"{note.path}: {field} 与 registry.yaml 不一致")

    for key, item in repos.items():
        snapshot = item.get("snapshot_commit")
        synced = item.get("synced_commit")
        if item.get("tier") in {"core", "active"} and synced:
            note = notes.get(key)
            if note is None or note.meta.get("draft") is not False or note.meta.get("type") != "project":
                errors.append(f"registry.yaml: {key} 缺少对应的公开项目档案")
        if item.get("available") is not True or item.get("tier") == "ignore" or not snapshot:
            continue
        directory = ROOT / "raw" / "snapshots" / key
        relative = directory.relative_to(ROOT)
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
            path = unquote((link["path"] or "").replace(r"\(", "(").replace(r"\)", ")"))
            files, directories = trees[key]
            if link["kind"].lower() == "blob":
                exists = path in files
            else:
                exists = not path or path.removesuffix("/") in directories
            if not exists:
                yield f"{note.path}: GitHub 源码链接在快照目录树中不存在 ({link[0]})"


def check_mermaid(note):
    for number, code in enumerate(mermaid_blocks(note.body), start=1):
        lines = [line.strip() for line in code.splitlines() if line.strip() and not line.lstrip().startswith("%%")]
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


def check_content(notes, registry):
    errors, warnings = check_links(notes)
    repos = registry["repos"]
    registry_errors, trees = check_registry(notes, repos)
    errors.extend(registry_errors)
    registered = {item["repo"].casefold(): (key, item.get("synced_commit")) for key, item in repos.items()}
    for note in notes.values():
        errors.extend(check_source_links(note, registered, trees))
        errors.extend(check_mermaid(note))
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
    errors.extend(scan_secrets())
    for warning in warnings:
        print(f"WARNING {redact_secrets(warning)}")
    for error in errors:
        print(f"ERROR {redact_secrets(error)}")
    print(f"检查 {len(notes)} 页，{len(errors)} 个错误，{len(warnings)} 个提醒。")
    return int(bool(errors))


if __name__ == "__main__":
    raise SystemExit(main())
