"""Tool schema extractor.

Finds ``registry.register(...)`` calls (and ``ctx.register_tool(...)`` calls in
plugins) and records every schema that is a static literal. A schema counts as
literal when ``common.evaluate`` can resolve it from the same module (inline
dict, or a module-level constant built from literals). All others are listed by
name and file with the reason, so a reviewer sees what the extractor missed.
"""

from __future__ import annotations

import ast
from pathlib import Path
from typing import Any

from common import Unresolved, call_name, evaluate, iter_py_files, module_env, parse_file, rel

# Positional order of ToolRegistry.register and PluginContext.register_tool.
POSITIONAL = ["name", "toolset", "schema", "handler"]


def _via(name: str) -> str | None:
    if name == "registry.register" or name.endswith(".registry.register"):
        return "registry.register"
    if name == "register_tool" or name.endswith(".register_tool"):
        return "ctx.register_tool"
    return None


def _scalar(node: ast.expr | None, env: dict[str, ast.expr]) -> str | None:
    if node is None:
        return None
    try:
        v = evaluate(node, env)
    except Unresolved:
        return None
    return v if isinstance(v, str) else None


def extract(root: Path) -> dict[str, Any]:
    literal: list[dict[str, Any]] = []
    non_literal: list[dict[str, Any]] = []
    for path in iter_py_files(root):
        text = path.read_text(encoding="utf-8", errors="replace")
        if "register" not in text:
            continue
        tree = parse_file(path)
        if tree is None:
            continue
        env = module_env(tree)
        file_rel = rel(root, path)
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            via = _via(call_name(node))
            if via is None:
                continue
            args: dict[str, ast.expr] = {}
            for i, a in enumerate(node.args[: len(POSITIONAL)]):
                args[POSITIONAL[i]] = a
            for kw in node.keywords:
                if kw.arg:
                    args[kw.arg] = kw.value
            if "schema" not in args:
                continue
            entry: dict[str, Any] = {
                "name": _scalar(args.get("name"), env),
                "toolset": _scalar(args.get("toolset"), env),
                "file": file_rel,
                "line": node.lineno,
                "via": via,
            }
            try:
                schema = evaluate(args["schema"], env)
                if not isinstance(schema, dict):
                    raise Unresolved("schema is not a dict")
            except Unresolved as exc:
                entry["reason"] = str(exc)
                if entry["name"] is None and "name" in args:
                    entry["name_expr"] = ast.unparse(args["name"])[:120]
                entry["schema_expr"] = ast.unparse(args["schema"])[:120]
                non_literal.append(entry)
                continue
            entry["schema"] = schema
            literal.append(entry)

    def key(e: dict[str, Any]) -> tuple[str, str, int]:
        return (e["name"] or "", e["file"], e["line"])

    literal.sort(key=key)
    non_literal.sort(key=key)
    names = sorted({e["name"] for e in literal if e["name"]})
    return {
        "surface": "tool-schemas",
        "counts": {
            "literal": len(literal),
            "literal_unique_names": len(names),
            "literal_via_registry": sum(1 for e in literal if e["via"] == "registry.register"),
            "literal_via_plugin_ctx": sum(1 for e in literal if e["via"] == "ctx.register_tool"),
            "non_literal": len(non_literal),
        },
        "tools": literal,
        "non_literal": non_literal,
    }
