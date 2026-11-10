"""Hook ABI extractor.

Names: the ``VALID_HOOKS`` set literal in ``hermes_cli/plugins.py``.
Kwargs: every call site that dispatches a hook by a literal name. A call site is
a call whose last name part contains ``invoke_hook`` (``invoke_hook``,
``ainvoke_hook``, ``_invoke_hook``, ``_invoke_hook_safely`` and so on), or
``fire_pre_command_hook``. The keyword names at the site are the kwargs. For
``**payload`` the extractor looks for a dict literal assigned to that name in the
same function and uses its string keys; if it cannot, the site is marked
``dynamic_kwargs``.
"""

from __future__ import annotations

import ast
from pathlib import Path
from typing import Any

from common import call_name, iter_py_files, parse_file, rel

PLUGINS = "hermes_cli/plugins.py"


def _set_literal(tree: ast.Module, name: str) -> list[str]:
    for node in tree.body:
        target = None
        value = None
        if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            target, value = node.target.id, node.value
        elif isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
            target, value = node.targets[0].id, node.value
        if target == name and isinstance(value, (ast.Set, ast.List, ast.Tuple)):
            return [e.value for e in value.elts if isinstance(e, ast.Constant) and isinstance(e.value, str)]
    return []


def _is_hook_call(name: str) -> bool:
    last = name.rsplit(".", 1)[-1].lower()
    if "hook" not in last and last != "fire_pre_command_hook":
        return False
    return not (last.startswith("has_") or "register" in last or last.startswith("get_"))


def _dict_keys_for(func: ast.AST | None, var: str) -> list[str] | None:
    """String keys of a dict literal assigned to ``var`` inside ``func``."""
    if func is None:
        return None
    keys: set[str] = set()
    found = False
    for node in ast.walk(func):
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == var for t in node.targets):
            if isinstance(node.value, ast.Dict):
                found = True
                for k in node.value.keys:
                    if isinstance(k, ast.Constant) and isinstance(k.value, str):
                        keys.add(k.value)
        # payload["x"] = ... adds a key
        if isinstance(node, ast.Assign):
            for t in node.targets:
                if (isinstance(t, ast.Subscript) and isinstance(t.value, ast.Name) and t.value.id == var
                        and isinstance(t.slice, ast.Constant) and isinstance(t.slice.value, str)):
                    keys.add(t.slice.value)
    return sorted(keys) if found else None


def _walk(node: ast.AST, func: ast.AST | None):
    for child in ast.iter_child_nodes(node):
        f = child if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)) else func
        yield child, f
        yield from _walk(child, f)


def extract(root: Path) -> dict[str, Any]:
    plugins_path = root / PLUGINS
    tree = parse_file(plugins_path)
    valid = sorted(_set_literal(tree, "VALID_HOOKS")) if tree else []
    shell_unsupported = sorted(_set_literal(tree, "SHELL_UNSUPPORTED_HOOKS")) if tree else []
    valid_set = set(valid)

    sites: dict[str, list[dict[str, Any]]] = {h: [] for h in valid}
    unknown_name_sites: list[dict[str, Any]] = []
    dynamic_name_sites = 0
    for path in iter_py_files(root):
        text = path.read_text(encoding="utf-8", errors="replace")
        if "hook" not in text:
            continue
        mod = parse_file(path)
        if mod is None:
            continue
        file_rel = rel(root, path)
        for node, func in _walk(mod, None):
            if not isinstance(node, ast.Call) or not _is_hook_call(call_name(node)):
                continue
            hook = None
            for a in node.args[:2]:
                if isinstance(a, ast.Constant) and isinstance(a.value, str) and a.value in valid_set:
                    hook = a.value
                    break
            if hook is None and call_name(node).rsplit(".", 1)[-1] == "fire_pre_command_hook":
                hook = "pre_command"
            if hook is None:
                for kw in node.keywords:
                    if kw.arg in ("hook_name", "event", "name") and isinstance(kw.value, ast.Constant) \
                            and kw.value.value in valid_set:
                        hook = kw.value.value
            if hook is None:
                # The hook name is a variable or a string outside VALID_HOOKS. Counted, not listed.
                dynamic_name_sites += 1
                continue
            kwargs: set[str] = set()
            dynamic = False
            for kw in node.keywords:
                if kw.arg:
                    kwargs.add(kw.arg)
                elif isinstance(kw.value, ast.Name):
                    keys = _dict_keys_for(func, kw.value.id)
                    if keys is None:
                        dynamic = True
                    else:
                        kwargs.update(keys)
                else:
                    dynamic = True
            site = {
                "via": call_name(node),
                "file": file_rel,
                "line": node.lineno,
                "kwargs": sorted(kwargs),
                "dynamic_kwargs": dynamic,
            }
            if hook in valid_set:
                sites[hook].append(site)
            else:
                unknown_name_sites.append({"hook": hook, **site})

    hooks = []
    for name in valid:
        ss = sorted(sites[name], key=lambda s: (s["file"], s["line"]))
        union = sorted({k for s in ss for k in s["kwargs"]})
        common = sorted(set.intersection(*[set(s["kwargs"]) for s in ss])) if ss else []
        hooks.append({
            "name": name,
            "call_sites": len(ss),
            "kwargs_union": union,
            "kwargs_in_every_site": common,
            "any_dynamic_kwargs": any(s["dynamic_kwargs"] for s in ss),
            "shell_unsupported": name in shell_unsupported,
            "sites": ss,
        })
    unknown_name_sites.sort(key=lambda s: (s["hook"], s["file"], s["line"]))
    return {
        "surface": "hook-abi",
        "source": PLUGINS,
        "counts": {
            "hook_names": len(valid),
            "hooks_with_no_literal_call_site": sum(1 for h in hooks if h["call_sites"] == 0),
            "call_sites_with_literal_name": sum(h["call_sites"] for h in hooks),
            "hook_like_calls_without_literal_name": dynamic_name_sites,
        },
        "hook_names": valid,
        "shell_unsupported": shell_unsupported,
        "hooks": hooks,
        "literal_names_outside_valid_hooks": unknown_name_sites,
    }
