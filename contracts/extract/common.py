"""Shared helpers for the static extractors.

Rules for every extractor in this folder:
- Python 3 standard library only.
- Upstream files are read as text and parsed with ``ast``. Nothing from the
  upstream tree is imported or executed.
- Output is deterministic: sorted keys, sorted lists, no timestamps, paths
  relative to the upstream root with forward slashes.
"""

from __future__ import annotations

import ast
import json
import os
import subprocess
from pathlib import Path
from typing import Any, Iterator

# Directories that hold tests or tooling. Their code is not part of the runtime
# contract, so every extractor skips them.
SKIP_DIRS = {
    ".git", "node_modules", "tests", "test", "evals", "__pycache__",
    ".venv", "venv", "build", "dist", "website", "docs",
}


def rel(root: Path, path: Path) -> str:
    return path.relative_to(root).as_posix()


def iter_py_files(root: Path) -> Iterator[Path]:
    """Yield runtime Python files in sorted order."""
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS)
        for name in sorted(filenames):
            if name.endswith(".py") and not name.startswith("test_"):
                yield Path(dirpath) / name


def parse_file(path: Path) -> ast.Module | None:
    try:
        return ast.parse(path.read_text(encoding="utf-8", errors="replace"), filename=str(path))
    except (SyntaxError, ValueError):
        return None


def upstream_commit(root: Path) -> str | None:
    """Read HEAD with ``git rev-parse``. This reads git metadata only."""
    try:
        out = subprocess.run(
            ["git", "-C", str(root), "rev-parse", "HEAD"],
            capture_output=True, text=True, check=True, timeout=30,
        )
        return out.stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return None


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(data, indent=2, sort_keys=True, ensure_ascii=False) + "\n"
    path.write_text(text, encoding="utf-8")


class Unresolved(Exception):
    """Raised when an expression is not a static literal."""


def module_env(tree: ast.Module) -> dict[str, ast.expr]:
    """Map module-level names to the expression assigned to them (last wins)."""
    env: dict[str, ast.expr] = {}
    for node in tree.body:
        if isinstance(node, ast.Assign):
            for t in node.targets:
                if isinstance(t, ast.Name):
                    env[t.id] = node.value
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name) and node.value is not None:
            env[node.target.id] = node.value
    return env


def evaluate(node: ast.expr, env: dict[str, ast.expr], _depth: int = 0, _seen: frozenset[str] = frozenset()) -> Any:
    """Evaluate a restricted subset of Python expressions to a JSON-like value.

    Supported: constants, dict/list/tuple/set displays, ``**`` unpacking of
    resolvable dicts, module-level names, ``+`` on str/list, f-strings whose
    parts all resolve. Anything else raises ``Unresolved`` with a short reason.
    """
    if _depth > 40:
        raise Unresolved("expression too deep")
    d = _depth + 1
    if isinstance(node, ast.Constant):
        return node.value
    if isinstance(node, ast.Name):
        if node.id in _seen:
            raise Unresolved(f"cyclic name {node.id}")
        if node.id not in env:
            raise Unresolved(f"name {node.id} is not a module-level assignment")
        return evaluate(env[node.id], env, d, _seen | {node.id})
    if isinstance(node, ast.Dict):
        out: dict[Any, Any] = {}
        for k, v in zip(node.keys, node.values):
            if k is None:
                inner = evaluate(v, env, d, _seen)
                if not isinstance(inner, dict):
                    raise Unresolved("** unpack of a non-dict")
                out.update(inner)
            else:
                key = evaluate(k, env, d, _seen)
                if not isinstance(key, (str, int, float, bool)) and key is not None:
                    raise Unresolved("non-scalar dict key")
                out[key] = evaluate(v, env, d, _seen)
        return out
    if isinstance(node, (ast.List, ast.Tuple, ast.Set)):
        items: list[Any] = []
        for e in node.elts:
            if isinstance(e, ast.Starred):
                inner = evaluate(e.value, env, d, _seen)
                if not isinstance(inner, (list, tuple, set)):
                    raise Unresolved("* unpack of a non-sequence")
                items.extend(inner)
            else:
                items.append(evaluate(e, env, d, _seen))
        return items
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        a = evaluate(node.left, env, d, _seen)
        b = evaluate(node.right, env, d, _seen)
        if isinstance(a, str) and isinstance(b, str):
            return a + b
        if isinstance(a, list) and isinstance(b, list):
            return a + b
        raise Unresolved("+ on unsupported types")
    if isinstance(node, ast.JoinedStr):
        parts = []
        for v in node.values:
            if isinstance(v, ast.Constant):
                parts.append(str(v.value))
            elif isinstance(v, ast.FormattedValue) and v.conversion == -1 and v.format_spec is None:
                val = evaluate(v.value, env, d, _seen)
                if not isinstance(val, (str, int, float)):
                    raise Unresolved("f-string part is not a scalar")
                parts.append(str(val))
            else:
                raise Unresolved("f-string with conversion or format spec")
        return "".join(parts)
    if isinstance(node, ast.Call) and not node.keywords:
        # Two pure builtins are safe to fold: list(x) / tuple(x), and "sep".join(x).
        if isinstance(node.func, ast.Name) and node.func.id in {"list", "tuple"} and len(node.args) == 1:
            inner = evaluate(node.args[0], env, d, _seen)
            if isinstance(inner, (list, tuple, set, dict)):
                return list(inner)
        if (isinstance(node.func, ast.Attribute) and node.func.attr == "join"
                and isinstance(node.func.value, ast.Constant) and isinstance(node.func.value.value, str)
                and len(node.args) == 1):
            inner = evaluate(node.args[0], env, d, _seen)
            if isinstance(inner, (list, tuple)) and all(isinstance(x, str) for x in inner):
                return node.func.value.value.join(inner)
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.USub):
        v = evaluate(node.operand, env, d, _seen)
        if isinstance(v, (int, float)):
            return -v
    raise Unresolved(f"unsupported expression {type(node).__name__}: {ast.unparse(node)[:80]}")


def call_name(node: ast.Call) -> str:
    """Dotted name of a call target, or '' when it is not a simple name chain."""
    parts: list[str] = []
    f = node.func
    while isinstance(f, ast.Attribute):
        parts.append(f.attr)
        f = f.value
    if isinstance(f, ast.Name):
        parts.append(f.id)
        return ".".join(reversed(parts))
    return ""
