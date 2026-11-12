"""State schema extractor.

Reads ``SCHEMA_VERSION`` and every ``CREATE TABLE`` / ``CREATE VIRTUAL TABLE``
string literal in the upstream runtime code.

Scope. A table is in the ``state.db`` scope when one of its definitions sits in
a file listed in ``STATE_DB_FILES``: the ``hermes_state*.py`` modules and the
modules that create state.db tables lazily (the reply outbox in
``gateway/delivery_ledger.py``, the restore stage in
``hermes_cli/backup_restore.py``). Tables from every other file are listed under
``other_stores`` with the database file names found in that file. They are not
part of the state.db contract, so the port needs no decision for them.

String handling. SQL text comes from ``ast``: plain strings, implicit and
``+`` concatenation, and f-strings (an unresolved ``{expr}`` stays as a
placeholder). A table whose name is a placeholder is resolved only from a
module-level list of ``(name, columns, ddl)`` entries in the same file (the
Telegram topic tables). Nothing is executed.
"""

from __future__ import annotations

import ast
import re
from pathlib import Path
from typing import Any

from common import Unresolved, evaluate, iter_py_files, module_env, parse_file, rel

COMMON = "hermes_state_common.py"

# Files whose tables live in the profile's state.db.
STATE_DB_FILES_EXPLICIT = {
    "gateway/delivery_ledger.py",        # delivery_obligations, created on first use
    "hermes_cli/backup_restore.py",      # runtime_epoch, written into a staged restore copy
    "tools/async_delegation.py",         # delegates to the canonical SCHEMA_SQL
}


def is_state_file(file_rel: str) -> bool:
    return (file_rel.startswith("hermes_state") and file_rel.endswith(".py") and "/" not in file_rel) \
        or file_rel in STATE_DB_FILES_EXPLICIT


CREATE_TABLE = re.compile(
    r"CREATE\s+(VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*|\{[^}]*\})",
    re.IGNORECASE)
CREATE_INDEX = re.compile(
    r"CREATE\s+(UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)\s+ON\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)"
    r"(?:\s+WHERE\s+([^;]*?))?\s*;", re.IGNORECASE)
CREATE_TRIGGER = re.compile(
    r"CREATE\s+TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)\s+((?:BEFORE|AFTER|INSTEAD\s+OF)\s+(?:INSERT|UPDATE|DELETE)[^\n]*?)\s+ON\s+([A-Za-z_][A-Za-z0-9_]*)",
    re.IGNORECASE)


def flatten(node: ast.AST) -> str | None:
    """Static text of a string expression; unresolved parts become ``{expr}``."""
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.JoinedStr):
        out = []
        for v in node.values:
            if isinstance(v, ast.Constant):
                out.append(str(v.value))
            elif isinstance(v, ast.FormattedValue):
                out.append("{" + ast.unparse(v.value) + "}")
        return "".join(out)
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        a, b = flatten(node.left), flatten(node.right)
        if a is not None and b is not None:
            return a + b
        return None
    if isinstance(node, ast.Name):
        return "{" + node.id + "}"
    return None


def string_nodes(tree: ast.Module):
    """Yield maximal string expressions with their line number."""
    handled: set[int] = set()
    for node in ast.walk(tree):
        if id(node) in handled:
            continue
        if isinstance(node, (ast.Constant, ast.JoinedStr, ast.BinOp)):
            text = flatten(node)
            if text is None:
                continue
            for sub in ast.walk(node):
                handled.add(id(sub))
            yield node.lineno, text


def strip_sql_comments(sql: str) -> str:
    return re.sub(r"--[^\n]*", "", sql)


def squash(sql: str) -> str:
    return re.sub(r"\s+", " ", sql).strip()


def match_paren(text: str, start: int) -> int:
    """Index of the ')' that closes the '(' at ``start``; -1 if none."""
    depth = 0
    quote = ""
    for i in range(start, len(text)):
        ch = text[i]
        if quote:
            if ch == quote:
                quote = ""
            continue
        if ch in "'\"":
            quote = ch
        elif ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
            if depth == 0:
                return i
    return -1


def split_top(body: str) -> list[str]:
    parts, cur, depth, quote = [], "", 0, ""
    for ch in body:
        if quote:
            cur += ch
            if ch == quote:
                quote = ""
            continue
        if ch in "'\"":
            quote = ch
            cur += ch
        elif ch == "(":
            depth += 1
            cur += ch
        elif ch == ")":
            depth -= 1
            cur += ch
        elif ch == "," and depth == 0:
            parts.append(cur)
            cur = ""
        else:
            cur += ch
    if cur.strip():
        parts.append(cur)
    return [squash(p) for p in parts if p.strip()]


CONSTRAINT_START = re.compile(r"^(PRIMARY\s+KEY|UNIQUE|CHECK|FOREIGN\s+KEY|CONSTRAINT)\b", re.IGNORECASE)


def parse_table_body(body: str) -> dict[str, Any]:
    columns, constraints = [], []
    unique: list[list[str]] = []
    primary_key: list[str] = []
    checks: list[str] = []
    for part in split_top(body):
        if CONSTRAINT_START.match(part):
            constraints.append(part)
            m = re.match(r"^(?:CONSTRAINT\s+\S+\s+)?(PRIMARY\s+KEY|UNIQUE)\s*\(([^)]*)\)", part, re.IGNORECASE)
            if m:
                cols = [c.strip() for c in m.group(2).split(",")]
                if m.group(1).upper().startswith("PRIMARY"):
                    primary_key = cols
                else:
                    unique.append(cols)
            else:
                m = re.match(r"^(?:CONSTRAINT\s+\S+\s+)?CHECK\b(.*)$", part, re.IGNORECASE)
                if m:
                    checks.append(squash(m.group(1)))
            continue
        name, _, rest = part.partition(" ")
        columns.append({"name": name, "definition": rest.strip()})
        if re.search(r"\bPRIMARY\s+KEY\b", rest, re.IGNORECASE):
            primary_key = [name]
        if re.search(r"\bUNIQUE\b", rest, re.IGNORECASE):
            unique.append([name])
        m = re.search(r"\bCHECK\s*(\(.*\))", rest, re.IGNORECASE)
        if m:
            checks.append(f"{name}: {m.group(1)}")
    return {
        "columns": columns,
        "constraints": constraints,
        "primary_key": primary_key,
        "unique": unique,
        "checks": checks,
    }


def parse_fts_args(body: str) -> dict[str, Any]:
    cols, opts = [], {}
    for part in split_top(body):
        if "=" in part:
            k, _, v = part.partition("=")
            opts[k.strip()] = v.strip().strip("'\"")
        else:
            cols.append(part)
    return {"columns": [{"name": c, "definition": ""} for c in cols], "fts5_options": opts}


def list_constants(tree: ast.Module) -> list[tuple[str, list[Any]]]:
    """Module-level lists of (identifier, str, str) entries, for dynamic table names."""
    env = module_env(tree)
    found = []
    for name, node in env.items():
        if isinstance(node, (ast.Tuple, ast.List)):
            try:
                val = evaluate(node, env)
            except Unresolved:
                continue
            if val and all(isinstance(e, list) and len(e) == 3 and all(isinstance(x, str) for x in e)
                           and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", e[0]) for e in val):
                found.append((name, val))
    return found


def scan_file(root: Path, path: Path) -> dict[str, list[dict[str, Any]]]:
    text = path.read_text(encoding="utf-8", errors="replace")
    if "CREATE" not in text.upper():
        return {"tables": [], "indexes": [], "triggers": []}
    tree = parse_file(path)
    if tree is None:
        return {"tables": [], "indexes": [], "triggers": []}
    file_rel = rel(root, path)
    tables, indexes, triggers = [], [], []
    dynamic_lists = None
    for line, raw in string_nodes(tree):
        if not re.search(r"CREATE\s+(VIRTUAL\s+)?TABLE|CREATE\s+(UNIQUE\s+)?INDEX|CREATE\s+TRIGGER", raw, re.IGNORECASE):
            continue
        sql = strip_sql_comments(raw)
        for m in CREATE_TABLE.finditer(sql):
            name = m.group(2)
            virtual = bool(m.group(1))
            open_idx = sql.find("(", m.end())
            using = sql[m.end():open_idx] if open_idx != -1 else ""
            if open_idx == -1 or (not virtual and re.search(r"[A-Za-z]", using.replace("AS", ""))):
                continue
            close = match_paren(sql, open_idx)
            if close == -1:
                continue
            body = sql[open_idx + 1:close]
            if virtual:
                um = re.match(r"\s*USING\s+(\w+)", sql[m.end():open_idx], re.IGNORECASE)
                # The "(" found above may belong to the module name; keep the fts5 argument list.
                if not um:
                    continue
                parsed = parse_fts_args(body)
                parsed.update({"constraints": [], "primary_key": [], "unique": [], "checks": []})
                module = um.group(1).lower()
            else:
                parsed = parse_table_body(body)
                module = None
            targets = [(name, parsed, squash(sql[m.start():close + 1]))]
            if name.startswith("{"):
                if dynamic_lists is None:
                    dynamic_lists = list_constants(tree)
                targets = []
                for _, entries in dynamic_lists:
                    for tname, _cols, ddl in entries:
                        p = parse_table_body(ddl)
                        targets.append((tname, p, squash(f"CREATE TABLE {tname} ({ddl})")))
            for tname, p, ddl in targets:
                tables.append({
                    "name": tname,
                    "kind": "virtual" if virtual else "table",
                    "module": module,
                    "file": file_rel,
                    "line": line + sql[:m.start()].count("\n"),
                    "sql": ddl,
                    **p,
                })
        for m in CREATE_INDEX.finditer(sql + ";"):
            indexes.append({
                "name": m.group(2), "table": m.group(3), "unique": bool(m.group(1)),
                "columns": [c.strip() for c in m.group(4).split(",")],
                "where": squash(m.group(5)) if m.group(5) else None,
                "file": file_rel, "line": line + sql[:m.start()].count("\n"),
            })
        for m in CREATE_TRIGGER.finditer(sql):
            triggers.append({"name": m.group(1), "event": squash(m.group(2)), "table": m.group(3),
                             "file": file_rel, "line": line + sql[:m.start()].count("\n")})
    return {"tables": tables, "indexes": indexes, "triggers": triggers}


def read_int_constant(root: Path, file: str, name: str) -> int | None:
    tree = parse_file(root / file)
    if tree is None:
        return None
    env = module_env(tree)
    try:
        v = evaluate(env[name], env) if name in env else None
    except Unresolved:
        return None
    return v if isinstance(v, int) else None


def db_hints(path: Path) -> list[str]:
    text = path.read_text(encoding="utf-8", errors="replace")
    return sorted({m for m in re.findall(r"[A-Za-z_\-]+\.(?:db|sqlite3?)\b", text)
                   if not m.startswith(("self.", "db.", "hermes_cli.", "conn."))})


def extract(root: Path) -> dict[str, Any]:
    schema_version = read_int_constant(root, COMMON, "SCHEMA_VERSION")
    fts_version = read_int_constant(root, COMMON, "FTS_STORAGE_VERSION")

    state: dict[str, dict[str, Any]] = {}
    state_indexes: list[dict[str, Any]] = []
    state_triggers: list[dict[str, Any]] = []
    other: list[dict[str, Any]] = []
    other_files_hints: dict[str, list[str]] = {}

    for path in iter_py_files(root):
        file_rel = rel(root, path)
        found = scan_file(root, path)
        if not (found["tables"] or found["indexes"] or found["triggers"]):
            continue
        if is_state_file(file_rel):
            for t in found["tables"]:
                cur = state.get(t["name"])
                entry_def = {k: t[k] for k in ("file", "line", "sql")}
                if cur is None:
                    state[t["name"]] = {**t, "other_definitions": []}
                    continue
                # The canonical definition is the one in hermes_state_common.py; others are copies.
                if t["file"] == COMMON and cur["file"] != COMMON:
                    old = {k: cur[k] for k in ("file", "line", "sql")}
                    state[t["name"]] = {**t, "other_definitions": cur["other_definitions"] + [old]}
                else:
                    cur["other_definitions"].append(entry_def)
            state_indexes.extend(found["indexes"])
            state_triggers.extend(found["triggers"])
        else:
            other_files_hints[file_rel] = db_hints(path)
            for t in found["tables"]:
                other.append({"name": t["name"], "kind": t["kind"], "file": t["file"], "line": t["line"]})

    tables = []
    for name in sorted(state):
        t = state[name]
        t["other_definitions"].sort(key=lambda d: (d["file"], d["line"]))
        t["created_lazily"] = t["file"] != COMMON
        t["indexes"] = sorted(
            [i for i in state_indexes if i["table"] == name], key=lambda i: (i["name"], i["file"], i["line"]))
        t["triggers"] = sorted(
            [i for i in state_triggers if i["table"] == name], key=lambda i: (i["name"], i["file"], i["line"]))
        tables.append(t)
    other.sort(key=lambda t: (t["file"], t["line"], t["name"]))
    # Deduplicate other-store rows (the same CREATE can appear in a rebuild path).
    seen, other_unique = set(), []
    for t in other:
        key = (t["file"], t["name"])
        if key not in seen:
            seen.add(key)
            other_unique.append(t)
    ordinary = [t for t in tables if t["kind"] == "table"]
    virtual = [t for t in tables if t["kind"] == "virtual"]
    return {
        "surface": "state-schema",
        "schema_version": schema_version,
        "fts_storage_version": fts_version,
        "state_db_files_rule": "hermes_state*.py at the repo root, plus " + ", ".join(sorted(STATE_DB_FILES_EXPLICIT)),
        "counts": {
            "state_db_tables_total": len(tables),
            "ordinary": len(ordinary),
            "ordinary_in_schema_sql": sum(1 for t in ordinary if not t["created_lazily"]),
            "ordinary_created_lazily": sum(1 for t in ordinary if t["created_lazily"]),
            "virtual_fts5": len(virtual),
            "other_store_tables": len(other_unique),
        },
        "tables": tables,
        "other_stores": {
            "note": "Tables in files outside the state.db scope. db_hints lists database file names found in the file.",
            "files": {f: other_files_hints[f] for f in sorted(other_files_hints)},
            "tables": other_unique,
        },
    }
