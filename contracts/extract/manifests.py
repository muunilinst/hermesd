"""Bundled plugin manifest extractor.

Reads every ``plugin.yaml`` under the upstream tree (test fixtures excluded),
parses it with a small YAML subset parser, and classes the plugin.

Class heuristic, from the files that sit next to the manifest (recursively,
not inside a nested plugin that has its own manifest):

- ``python``: at least one ``*.py`` file. Python wins when JS files exist too;
  ``mixed`` is then true.
- ``js``: no ``*.py`` file and at least one ``*.js``, ``*.mjs``, ``*.cjs`` or
  ``*.ts`` file, or a ``package.json``.
- ``portable``: no code file at all. The plugin is only a manifest plus data
  (skills, MCP config, docs).

The class is a static guess from file extensions. It does not read the code.
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any

from common import SKIP_DIRS, rel

JS_EXT = {".js", ".mjs", ".cjs", ".ts"}


class YamlError(Exception):
    pass


def _scalar(text: str) -> Any:
    t = text.strip()
    if t == "" or t in ("~", "null", "Null", "NULL"):
        return None
    if t in ("true", "True", "yes"):
        return True
    if t in ("false", "False", "no"):
        return False
    if len(t) >= 2 and t[0] == '"' and t[-1] == '"':
        try:
            return json.loads(t)
        except ValueError:
            return t[1:-1]
    if len(t) >= 2 and t[0] == "'" and t[-1] == "'":
        return t[1:-1].replace("''", "'")
    if t.startswith("[") and t.endswith("]"):
        inner = t[1:-1].strip()
        if not inner:
            return []
        return [_scalar(p) for p in _split_flow(inner)]
    if t == "{}":
        return {}
    if re.fullmatch(r"-?\d+", t):
        return int(t)
    if re.fullmatch(r"-?\d+\.\d+", t):
        return float(t)
    return re.sub(r"\s+#.*$", "", t)


def _split_flow(s: str) -> list[str]:
    parts, cur, quote = [], "", ""
    for ch in s:
        if quote:
            cur += ch
            if ch == quote:
                quote = ""
        elif ch in "\"'":
            quote = ch
            cur += ch
        elif ch == ",":
            parts.append(cur)
            cur = ""
        else:
            cur += ch
    parts.append(cur)
    return [p.strip() for p in parts if p.strip()]


def _strip_comment_lines(lines: list[str]) -> list[tuple[int, str]]:
    out = []
    for raw in lines:
        if not raw.strip() or raw.lstrip().startswith("#"):
            out.append((-1, ""))
            continue
        out.append((len(raw) - len(raw.lstrip(" ")), raw.strip()))
    return out


def parse_yaml(text: str) -> Any:
    """Parse the YAML subset used by plugin manifests.

    Supported: block mappings, block sequences (scalars or mappings), nested
    mappings, flow lists on one line, quoted and plain scalars, ``>`` and ``|``
    block scalars, comments on their own line. Anything else raises YamlError.
    """
    lines = text.expandtabs(2).splitlines()
    entries = _strip_comment_lines(lines)
    pos = 0

    def skip_blank(i: int) -> int:
        while i < len(entries) and entries[i][0] == -1:
            i += 1
        return i

    def block_scalar(i: int, parent_indent: int, style: str) -> tuple[str, int]:
        # Collect following lines that are more indented than the parent key (blank lines kept).
        collected: list[str] = []
        j = i
        base = None
        while j < len(lines):
            raw = lines[j]
            if raw.strip() == "":
                collected.append("")
                j += 1
                continue
            ind = len(raw) - len(raw.lstrip(" "))
            if ind <= parent_indent:
                break
            if base is None:
                base = ind
            collected.append(raw[base:] if ind >= base else raw.strip())
            j += 1
        while collected and collected[-1] == "":
            collected.pop()
        if style.startswith(">"):
            paras, cur = [], []
            for ln in collected:
                if ln == "":
                    paras.append(" ".join(cur))
                    cur = []
                else:
                    cur.append(ln)
            paras.append(" ".join(cur))
            return "\n".join(paras), j
        return "\n".join(collected), j

    def parse_block(i: int, indent: int) -> tuple[Any, int]:
        i = skip_blank(i)
        if i >= len(entries):
            return None, i
        if entries[i][1].startswith("- ") or entries[i][1] == "-":
            return parse_seq(i, entries[i][0])
        return parse_map(i, entries[i][0])

    def parse_seq(i: int, indent: int) -> tuple[list[Any], int]:
        items: list[Any] = []
        while True:
            i = skip_blank(i)
            if i >= len(entries) or entries[i][0] != indent or not (entries[i][1].startswith("- ") or entries[i][1] == "-"):
                return items, i
            body = entries[i][1][1:].strip()
            if body == "":
                val, i = parse_block(i + 1, indent + 1)
                items.append(val)
                continue
            m = re.match(r"^([A-Za-z0-9_.\-]+):(?:\s+(.*))?$", body)
            if m and not body.startswith(('"', "'")):
                # A mapping item. Re-read the line as a map entry at the deeper indent.
                child_indent = indent + 2
                entries[i] = (child_indent, body)
                val, i = parse_map(i, child_indent)
                items.append(val)
            else:
                items.append(_scalar(body))
                i += 1

    def parse_map(i: int, indent: int) -> tuple[dict[str, Any], int]:
        out: dict[str, Any] = {}
        while True:
            i = skip_blank(i)
            if i >= len(entries) or entries[i][0] != indent:
                if i < len(entries) and entries[i][0] > indent:
                    raise YamlError(f"unexpected indent at line {i + 1}")
                return out, i
            line = entries[i][1]
            m = re.match(r'^("[^"]*"|\'[^\']*\'|[^:#][^:]*?):(?:\s+(.*))?$', line)
            if not m:
                raise YamlError(f"cannot read line {i + 1}: {line[:60]}")
            key = _scalar(m.group(1))
            rest = (m.group(2) or "").strip()
            if rest in (">", "|", ">-", "|-", ">+", "|+"):
                val, i = block_scalar(i + 1, indent, rest)
            elif rest == "":
                j = skip_blank(i + 1)
                if j < len(entries) and (entries[j][0] > indent or
                                         (entries[j][0] == indent and entries[j][1].startswith("-"))):
                    val, i = parse_block(j, entries[j][0])
                else:
                    val, i = None, i + 1
            else:
                val, i = _scalar(rest), i + 1
            if not isinstance(key, str):
                key = str(key)
            out[key] = val

    i0 = skip_blank(0)
    if i0 >= len(entries):
        return {}
    value, end = parse_block(i0, entries[i0][0])
    end = skip_blank(end)
    if end < len(entries):
        raise YamlError(f"unparsed content at line {end + 1}")
    return value


def load_manifest(path: Path) -> tuple[Any, str | None]:
    text = path.read_text(encoding="utf-8", errors="replace")
    stripped = text.lstrip()
    try:
        if stripped.startswith("{"):
            return json.loads(text), None
        return parse_yaml(text), None
    except (YamlError, ValueError) as exc:
        return None, str(exc)


def classify(plugin_dir: Path, nested: set[Path]) -> dict[str, Any]:
    py = js = 0
    other_data = 0
    for dirpath, dirnames, filenames in os.walk(plugin_dir):
        here = Path(dirpath)
        dirnames[:] = sorted(
            d for d in dirnames
            if d not in SKIP_DIRS and (here / d) not in nested and d not in {"node_modules"}
        )
        for name in filenames:
            ext = os.path.splitext(name)[1].lower()
            if ext == ".py":
                py += 1
            elif ext in JS_EXT or name == "package.json":
                js += 1
            elif name != "plugin.yaml":
                other_data += 1
    if py:
        cls = "python"
    elif js:
        cls = "js"
    else:
        cls = "portable"
    return {"class": cls, "python_files": py, "js_files": js, "other_files": other_data, "mixed": bool(py and js)}


def extract(root: Path, valid_hooks: list[str] | None = None) -> dict[str, Any]:
    manifests: list[Path] = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS)
        if "plugin.yaml" in filenames:
            manifests.append(Path(dirpath) / "plugin.yaml")
    manifests.sort()
    dirs = {m.parent for m in manifests}
    entries = []
    for m in manifests:
        data, err = load_manifest(m)
        nested = {d for d in dirs if d != m.parent and m.parent in d.parents}
        info = classify(m.parent, nested)
        e: dict[str, Any] = {
            "path": rel(root, m),
            "parsed": err is None and isinstance(data, dict),
            **info,
        }
        if err is not None or not isinstance(data, dict):
            e["error"] = err or "manifest is not a mapping"
        else:
            e["name"] = data.get("name")
            e["version"] = data.get("version")
            e["kind"] = data.get("kind", "standalone")
            e["keys"] = sorted(data.keys())
            hooks = data.get("provides_hooks") or []
            tools = data.get("provides_tools") or []
            e["provides_hooks"] = sorted(hooks) if isinstance(hooks, list) else hooks
            e["provides_tools"] = sorted(tools) if isinstance(tools, list) else tools
            if valid_hooks is not None and isinstance(hooks, list):
                e["unknown_hooks"] = sorted(h for h in hooks if h not in valid_hooks)
            for k in ("requires_env", "optional_env"):
                v = data.get(k)
                if isinstance(v, list):
                    e[k + "_count"] = len(v)
        entries.append(e)
    by_class: dict[str, int] = {}
    for e in entries:
        by_class[e["class"]] = by_class.get(e["class"], 0) + 1
    by_kind: dict[str, int] = {}
    for e in entries:
        k = str(e.get("kind"))
        by_kind[k] = by_kind.get(k, 0) + 1
    return {
        "surface": "manifests",
        "heuristic": "python if any .py beside the manifest; else js if any .js/.mjs/.cjs/.ts/package.json; else portable (no code)",
        "counts": {
            "manifests": len(entries),
            "parsed": sum(1 for e in entries if e["parsed"]),
            "parse_errors": sum(1 for e in entries if not e["parsed"]),
            "by_class": dict(sorted(by_class.items())),
            "by_kind": dict(sorted(by_kind.items())),
        },
        "manifests": entries,
    }
