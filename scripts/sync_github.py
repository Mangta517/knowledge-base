"""Inventory public repositories and maintain commit-pinned GitHub snapshots."""

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path, PurePosixPath
from tempfile import NamedTemporaryFile
from urllib.parse import quote

import yaml

from lint_kb import ROOT, SLUG, SNAPSHOT_FILES, load_yaml, redact_secrets, secret_hits

REGISTRY = ROOT / "registry.yaml"
FIELDS = (
    "nameWithOwner,description,defaultBranchRef,visibility,isPrivate,isFork,isArchived,"
    "stargazerCount,primaryLanguage,pushedAt,diskUsage,url"
)
SKIP_DIRS = {"node_modules", ".git", "build", "dist", "target", "__pycache__"}
CORE_PRIORITY = {"watch", "bootloader", "flight"}
DRIFT_LABELS = {
    "unavailable": "已不在公开清单",
    "ignored": "已忽略",
    "no_default_branch": "无默认分支",
    "untracked": "未入库新仓",
    "snapshot_outdated": "远端 HEAD 尚未拉取快照",
    "content_outdated": "快照已更新，待刷新档案",
    "up_to_date": "已最新",
}


class GitHubError(ValueError):
    def __init__(self, message, status=None):
        super().__init__(message)
        self.status = status


def gh(*args, decode=True):
    env = os.environ.copy()
    env.update(GH_PROMPT_DISABLED="1", GH_PAGER="cat", GH_NO_UPDATE_NOTIFIER="1")
    result = subprocess.run(["gh", *args], env=env, capture_output=True, encoding="utf-8", errors="replace")
    if result.returncode:
        status = re.search(r"\bHTTP (\d{3})\b", result.stderr)
        if status:
            code = int(status[1])
            raise GitHubError(f"GitHub HTTP {code} ({args[0]})", code)
        raise GitHubError(f"gh {args[0]} 失败，请检查 gh auth status 和 GitHub 网络连接")
    if decode:
        return json.loads(result.stdout)
    return result.stdout


def inventory(owner):
    if not owner:
        owner = gh("api", "user")["login"]
    repos = gh("repo", "list", owner, "--limit", "200", "--visibility", "public", "--json", FIELDS)
    if len(repos) == 200:
        endpoint = f"users/{owner}/repos?type=owner&per_page=100"
        pages = gh("api", "--paginate", "--slurp", endpoint)
        full_names = {repo["full_name"].casefold() for page in pages for repo in page if not repo["private"]}
        if len(full_names) > len(repos):
            repos = gh("repo", "list", owner, "--limit", str(len(full_names)), "--visibility", "public", "--json", FIELDS)
        names = {repo["nameWithOwner"].casefold() for repo in repos}
        if names != full_names:
            raise ValueError("两次 GitHub 盘点结果不一致，请重试")
    return owner, {
        repo["nameWithOwner"].casefold(): repo
        for repo in repos if repo["visibility"] == "PUBLIC" and not repo["isPrivate"]
    }


def guessed_tier(repo, core_names):
    if repo["isFork"] or not repo.get("defaultBranchRef") or not repo["diskUsage"]:
        return "ignore"
    name = repo["nameWithOwner"].split("/")[-1].lower()
    if re.fullmatch(r"(?:test|demo|hello-world|tmp)(?:[-_.]?\d+)?", name) and repo["diskUsage"] < 16:
        return "ignore"
    if name in core_names:
        return "core"
    if repo["isArchived"]:
        return "archive"
    return "active"


def default_domains(repo):
    name = repo["nameWithOwner"].lower()
    language = (repo["primaryLanguage"] or {}).get("name", "")
    if language in {"C", "C++", "Assembly"} or re.search(r"stm32|mspm|gd32|esp32|bootloader|watch|flight", name):
        return ["embedded"]
    if language in {"Java", "Kotlin"}:
        return ["mobile"]
    return ["software"]


def unique_id(name, occupied):
    base = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") or "repo"
    slug = base
    number = 2
    while slug in occupied:
        slug = f"{base}-{number}"
        number += 1
    return slug


def discovered(registry, owner, repos):
    current = registry["repos"]
    by_repo = {item["repo"].casefold(): key for key, item in current.items()}
    candidates = [
        repo for repo in repos.values()
        if guessed_tier(repo, set()) == "active" and default_domains(repo) == ["embedded"]
    ]
    candidates.sort(key=lambda repo: (repo["stargazerCount"], repo["diskUsage"]), reverse=True)
    core_names = {
        repo["nameWithOwner"].split("/")[-1].lower() for repo in candidates
        if repo["nameWithOwner"].split("/")[-1].lower() in CORE_PRIORITY
    }
    for repo in candidates:
        if len(core_names) >= 5:
            break
        core_names.add(repo["nameWithOwner"].split("/")[-1].lower())
    for name, repo in sorted(repos.items()):
        key = by_repo.get(name)
        if key is None:
            key = unique_id(repo["nameWithOwner"].split("/")[-1], current)
        branch = repo["defaultBranchRef"] or {}
        language = repo["primaryLanguage"] or {}
        item = current.setdefault(key, {})
        item.update({
            "repo": repo["nameWithOwner"], "repo_url": repo["url"], "visibility": "public",
            "available": True, "is_fork": repo["isFork"], "is_archived": repo["isArchived"],
            "default_branch": branch.get("name"), "primary_language": language.get("name"),
            "stars": repo["stargazerCount"], "pushed_at": repo["pushedAt"],
        })
        item.setdefault("tier", guessed_tier(repo, core_names))
        item.setdefault("publish_policy", "public")
        item.setdefault("domains", default_domains(repo))
        item.setdefault("snapshot_commit", None)
        item.setdefault("synced_commit", None)
    for item in current.values():
        if item["repo"].casefold() not in repos:
            item["available"] = False
    return {"owner": owner, "repos": dict(sorted(current.items()))}


def write_text(path, content):
    hits = list(secret_hits(content))
    if hits:
        label, line = hits[0]
        raise ValueError(f"{path.relative_to(ROOT)}:{line}: 疑似凭据 ({label})")
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with NamedTemporaryFile(mode="w", encoding="utf-8", newline="\n", dir=path.parent, delete=False) as handle:
            temporary = Path(handle.name)
            handle.write(content)
        temporary.replace(path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def write_registry(registry):
    write_text(REGISTRY, yaml.safe_dump(registry, allow_unicode=True, sort_keys=False))


def head(repo):
    branch = quote(repo["defaultBranchRef"]["name"], safe="")
    return gh("api", f"repos/{repo['nameWithOwner']}/commits/{branch}")


def blocked_path(path, kind):
    parts = PurePosixPath(path).parts
    directories = parts[:-1]
    if kind == "tree":
        directories = parts
    return any(part.lower() in SKIP_DIRS for part in directories)


def tree_paths(repository, tree_sha):
    endpoint = f"repos/{repository}/git/trees/"
    result = gh("api", f"{endpoint}{tree_sha}?recursive=1")
    if not result["truncated"]:
        return [entry["path"] for entry in result["tree"] if not blocked_path(entry["path"], entry["type"])]
    paths = []
    pending = [("", tree_sha)]
    while pending:
        prefix, sha = pending.pop()
        result = gh("api", endpoint + sha)
        if result["truncated"]:
            raise ValueError(f"{repository}: 单层目录树超出 GitHub API 上限")
        for entry in result["tree"]:
            path = prefix + entry["path"]
            if blocked_path(path, entry["type"]):
                continue
            paths.append(path)
            if entry["type"] == "tree":
                pending.append((path + "/", entry["sha"]))
    return paths


def download_readme(repository, sha):
    try:
        return gh("api", f"repos/{repository}/readme?ref={sha}", "-H", "Accept: application/vnd.github.raw+json", decode=False)
    except GitHubError as error:
        if error.status != 404:
            raise
        return "# README\n\n此提交没有 GitHub 可识别的 README。\n"


def sync_one(key, item, repo, force=False):
    if not re.fullmatch(SLUG, key):
        raise ValueError(f"非法快照 ID：{key}")
    repository = repo["nameWithOwner"]
    commit = head(repo)
    sha = commit["sha"]
    directory = ROOT / "raw" / "snapshots" / key
    if not force and sha == item.get("snapshot_commit") and all((directory / name).is_file() for name in SNAPSHOT_FILES):
        print(f"已最新 {key} {sha[:12]}", flush=True)
        return

    paths = tree_paths(repository, commit["commit"]["tree"]["sha"])
    readme = download_readme(repository, sha)
    info = {
        "id": key, "repo": repository, "repo_url": repo["url"], "description": repo["description"],
        "visibility": "public", "default_branch": repo["defaultBranchRef"]["name"],
        "commit": sha, "commit_date": commit["commit"]["committer"]["date"],
        "is_fork": repo["isFork"], "is_archived": repo["isArchived"],
        "primary_language": (repo["primaryLanguage"] or {}).get("name"),
        "stars": repo["stargazerCount"],
    }
    files = {
        "tree.txt": "\n".join(sorted(paths)) + "\n",
        "readme.md": readme.strip("\ufeff\r\n") + "\n",
        "meta.json": json.dumps(info, ensure_ascii=False, indent=2) + "\n",
    }
    for name, content in files.items():
        hits = list(secret_hits(content))
        if hits:
            label, line = hits[0]
            raise ValueError(f"{key}/{name}:{line}: 疑似凭据 ({label})")
    for name, content in files.items():
        write_text(directory / name, content)
    item["snapshot_commit"] = sha
    print(f"已同步 {key} {sha[:12]}", flush=True)


def drift_rows(registry, repos):
    registered = {item["repo"].casefold() for item in registry["repos"].values()}
    for key, item in registry["repos"].items():
        repo = repos.get(item["repo"].casefold())
        current = item.get("synced_commit")
        snapshot = item.get("snapshot_commit")
        remote = None
        if repo is None:
            status = "unavailable"
        elif item["tier"] == "ignore":
            status = "ignored"
        elif not repo["defaultBranchRef"]:
            status = "no_default_branch"
        else:
            remote = head(repo)["sha"]
            if not current and not snapshot:
                status = "untracked"
            elif remote != snapshot:
                status = "snapshot_outdated"
            elif snapshot != current:
                status = "content_outdated"
            else:
                status = "up_to_date"
        yield {
            "id": key, "repo": item["repo"], "synced_commit": current, "snapshot_commit": snapshot,
            "remote_head": remote, "status": status,
        }
    for name in sorted(repos.keys() - registered):
        yield {
            "id": None, "repo": repos[name]["nameWithOwner"], "synced_commit": None, "snapshot_commit": None,
            "remote_head": None, "status": "untracked",
        }


def drift(registry, repos, as_json=False):
    rows = drift_rows(registry, repos)
    if as_json:
        print(json.dumps(list(rows), ensure_ascii=False, indent=2))
        return
    print("ID / Repo\t知识档案 SHA\t快照 SHA\t远端 HEAD\t状态", flush=True)
    for row in rows:
        commits = [(row[field] or "-")[:12] for field in ("synced_commit", "snapshot_commit", "remote_head")]
        print(row["id"] or row["repo"], *commits, DRIFT_LABELS[row["status"]], sep="\t", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--discover", action="store_true")
    action.add_argument("--sync", nargs="?", const="", metavar="ID")
    action.add_argument("--check-drift", action="store_true")
    parser.add_argument("--all", action="store_true")
    parser.add_argument("--force", action="store_true", help="强制重新下载选定快照")
    parser.add_argument("--json", action="store_true", help="将漂移报告输出为 JSON")
    args = parser.parse_args()
    if (args.all and args.sync != "") or (args.sync == "" and not args.all):
        parser.error("使用 --sync <id> 或 --sync --all")
    if args.force and args.sync is None:
        parser.error("--force 仅用于 --sync")
    if args.json and not args.check_drift:
        parser.error("--json 仅用于 --check-drift")
    try:
        registry = {"owner": None, "repos": {}}
        if REGISTRY.exists():
            registry = load_yaml(REGISTRY)
        owner, repos = inventory(registry["owner"])
        if args.discover:
            registry = discovered(registry, owner, repos)
            write_registry(registry)
            counts = {tier: 0 for tier in ("core", "active", "archive", "ignore")}
            print(f"{owner}：公开仓库 {len(repos)} 个")
            for key, item in registry["repos"].items():
                if item["available"]:
                    counts[item["tier"]] += 1
                    print(f"{item['tier']}\t{key}\t{item['repo']}")
            print("  ".join(f"{tier}={count}" for tier, count in counts.items()))
            return 0
        if args.check_drift:
            drift(registry, repos, as_json=args.json)
            return 0
        if args.all:
            keys = [
                key for key, item in registry["repos"].items()
                if item["tier"] != "ignore" and item["repo"].casefold() in repos
            ]
        else:
            keys = [args.sync]
        failed = False
        for key in keys:
            try:
                item = registry["repos"].get(key)
                if item is None:
                    raise ValueError(f"{key}: 未登记，请先运行 --discover")
                if item["tier"] == "ignore":
                    raise ValueError(f"{key}: 已忽略，请先审核分级")
                repo = repos.get(item["repo"].casefold())
                if repo is None or not repo["defaultBranchRef"]:
                    raise ValueError(f"{key}: 当前公开清单中没有可同步的默认分支")
                previous = item.get("snapshot_commit")
                sync_one(key, item, repo, force=args.force)
                if item.get("snapshot_commit") != previous:
                    write_registry(registry)
            except (OSError, ValueError) as error:
                print(f"ERROR {redact_secrets(str(error))}", file=sys.stderr, flush=True)
                failed = True
        return int(failed)
    except (OSError, ValueError) as error:
        print(f"ERROR {redact_secrets(str(error))}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
