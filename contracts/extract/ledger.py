"""Recovery ledger extractor.

For ``session_admissions``, ``worker_executions`` and ``worker_receipts`` (and
for context ``runtime_epoch``, ``delivery_obligations`` and ``async_delegations``)
this records:

- the status set declared in the CHECK constraint of the DDL,
- the uniqueness rules: UNIQUE constraints, primary keys, unique indexes,
- foreign keys and delete triggers that guard the tables,
- every ``UPDATE <table> SET status=...`` found in runtime SQL strings, with the
  statuses named in the same statement's WHERE clause as the "from" set.

Everything comes from SQL string literals parsed with ``ast``. Nothing runs.
"""

from __future__ import annotations

import ast
import re
from pathlib import Path
from typing import Any

import state_schema
from common import iter_py_files, parse_file, rel

LEDGER = ["session_admissions", "worker_executions", "worker_receipts"]
CONTEXT = ["runtime_epoch", "delivery_obligations", "async_delegations"]
STATE_COLUMNS = {"delivery_obligations": "state", "async_delegations": "delivery_state"}

UPDATE_RE = re.compile(r"UPDATE\s+([A-Za-z_]+)\s+SET\s+(.*?)(?:\s+WHERE\s+(.*))?$", re.IGNORECASE | re.DOTALL)


def _quoted_list(text: str) -> list[str]:
    return sorted(set(re.findall(r"'([^']*)'", text)))


def _status_set(column_defs: list[dict[str, str]], col: str) -> list[str] | None:
    for c in column_defs:
        if c["name"] == col:
            m = re.search(r"\bIN\s*\(([^)]*)\)", c["definition"], re.IGNORECASE)
            if m:
                return _quoted_list(m.group(1))
    return None


def _scan_updates(root: Path, tables: set[str]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for path in iter_py_files(root):
        text = path.read_text(encoding="utf-8", errors="replace")
        if "UPDATE" not in text:
            continue
        if not any(t in text for t in tables):
            continue
        tree = parse_file(path)
        if tree is None:
            continue
        file_rel = rel(root, path)
        for line, raw in state_schema.string_nodes(tree):
            if "UPDATE" not in raw.upper():
                continue
            sql = state_schema.squash(state_schema.strip_sql_comments(raw))
            m = UPDATE_RE.search(sql[sql.upper().find("UPDATE"):])
            if not m or m.group(1) not in tables:
                continue
            table, sets, where = m.group(1), m.group(2), m.group(3) or ""
            col = STATE_COLUMNS.get(table, "status")
            sm = re.search(rf"(?:^|[ ,]){col}\s*=\s*'([^']*)'", sets)
            if not sm:
                continue
            frm: list[str] = []
            for wm in re.finditer(rf"\b{col}\s*(?:=\s*'([^']*)'|IN\s*\(([^)]*)\))", where, re.IGNORECASE):
                if wm.group(1):
                    frm.append(wm.group(1))
                else:
                    frm.extend(_quoted_list(wm.group(2)))
            out.append({
                "table": table,
                "to": sm.group(1),
                "from": sorted(set(frm)),
                "file": file_rel,
                "line": line + raw[: raw.upper().find("UPDATE")].count("\n"),
                "sql": sql[:220],
            })
    out.sort(key=lambda e: (e["table"], e["to"], e["file"], e["line"]))
    return out


def extract(root: Path, schema: dict[str, Any] | None = None) -> dict[str, Any]:
    schema = schema or state_schema.extract(root)
    by_name = {t["name"]: t for t in schema["tables"]}
    wanted = LEDGER + CONTEXT
    tables: dict[str, Any] = {}
    for name in wanted:
        t = by_name.get(name)
        if t is None:
            tables[name] = {"present": False}
            continue
        col = STATE_COLUMNS.get(name, "status")
        fks = []
        for c in t["columns"]:
            for fm in re.finditer(r"REFERENCES\s+(\w+)\s*\((\w+)\)(?:\s+ON\s+DELETE\s+(\w+(?:\s+\w+)?))?", c["definition"],
                                  re.IGNORECASE):
                fks.append({"column": c["name"], "references": f"{fm.group(1)}({fm.group(2)})",
                            "on_delete": (fm.group(3) or "").upper() or None})
        unique_indexes = [
            {"name": i["name"], "columns": i["columns"], "where": i["where"]}
            for i in t["indexes"] if i["unique"]
        ]
        guards = list(t["triggers"])
        tables[name] = {
            "present": True,
            "primary_key": t["primary_key"],
            "unique_constraints": sorted(t["unique"]),
            "unique_indexes": unique_indexes,
            "check_constraints": t["checks"],
            "status_column": col if any(c["name"] == col for c in t["columns"]) else None,
            "status_set": _status_set(t["columns"], col),
            "intent_set": _status_set(t["columns"], "intent") if name == "session_admissions" else None,
            "kind_set": _status_set(t["columns"], "kind") if name == "worker_executions" else None,
            "foreign_keys": fks,
            "own_triggers": [g["name"] for g in guards],
            "defined_in": f"{t['file']}:{t['line']}",
        }
    # The session delete guard names the ledger tables in its trigger body, not its header.
    session_guards = [
        {"name": g["name"], "on": g["table"], "event": g["event"]}
        for t in schema["tables"] if t["name"] == "sessions" for g in t["triggers"]
        if "ledger" in g["name"]
    ]
    updates = _scan_updates(root, set(wanted))
    # Status values seen in code but missing from the declared set.
    undeclared = []
    for u in updates:
        declared = (tables.get(u["table"]) or {}).get("status_set")
        if declared is not None and u["to"] not in declared:
            undeclared.append(u)
    return {
        "surface": "ledger",
        "counts": {
            "ledger_tables_present": sum(1 for n in LEDGER if tables[n].get("present")),
            "status_updates_found": len(updates),
            "updates_to_undeclared_status": len(undeclared),
        },
        "tables": tables,
        "session_delete_guard_triggers": session_guards,
        "status_updates": updates,
    }
