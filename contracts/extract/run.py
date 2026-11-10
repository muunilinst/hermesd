#!/usr/bin/env python3
"""Regenerate every contract surface from an upstream checkout.

    python3 -I contracts/extract/run.py <upstream-path> [--out contracts/upstream]

Static analysis only: files are read as text and parsed with ``ast``. Nothing
from the upstream tree is imported or executed. Output is deterministic.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

# Work under `python3 -I`, which leaves the script folder off sys.path.
sys.path.insert(0, str(Path(__file__).resolve().parent))

import hooks  # noqa: E402
import ledger  # noqa: E402
import manifests  # noqa: E402
import state_schema  # noqa: E402
import tools  # noqa: E402
from common import upstream_commit, write_json  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("upstream", type=Path, help="path to a hermes-agent checkout")
    default_out = Path(__file__).resolve().parent.parent / "upstream"
    ap.add_argument("--out", type=Path, default=default_out)
    args = ap.parse_args()

    root = args.upstream.resolve()
    if not (root / "hermes_state_common.py").is_file():
        print(f"error: {root} does not look like hermes-agent (no hermes_state_common.py)", file=sys.stderr)
        return 2
    commit = upstream_commit(root)

    hook_data = hooks.extract(root)
    schema = state_schema.extract(root)
    surfaces = {
        "tool-schemas": tools.extract(root),
        "hook-abi": hook_data,
        "manifests": manifests.extract(root, hook_data["hook_names"]),
        "state-schema": schema,
        "ledger": ledger.extract(root, schema),
    }
    for name, data in surfaces.items():
        data["upstream_commit"] = commit
        write_json(args.out / f"{name}.json", data)
        print(f"wrote {args.out / (name + '.json')}")

    c = surfaces
    print(
        "tools: {literal} literal, {non_literal} non-literal | hooks: {h} | manifests: {m} | "
        "state tables: {t} ordinary + {v} fts5 | schema {s}".format(
            literal=c["tool-schemas"]["counts"]["literal"],
            non_literal=c["tool-schemas"]["counts"]["non_literal"],
            h=hook_data["counts"]["hook_names"],
            m=c["manifests"]["counts"]["manifests"],
            t=schema["counts"]["ordinary"],
            v=schema["counts"]["virtual_fts5"],
            s=schema["schema_version"],
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
