# contracts

The upstream contract surfaces of porting guide section 7.1, extracted from hermes-agent by static analysis, plus the port's decisions about them.

Static analysis only. The extractors read upstream files as text and parse them with Python's `ast` module. They never import, install or run upstream code, and never run upstream scripts or tests.

## Layout

| Path | What it is |
| --- | --- |
| `extract/` | Python 3 standard-library extractors. `run.py` is the entry. |
| `upstream/*.json` | Generated, committed. One file per surface. Sorted and deterministic. |
| `table-decisions.json` | The port's decision for each state.db table (guide 2.4). Hand-written. |
| `known-hooks.json` | The hook names a person has reviewed. Hand-written. |
| `upstream-recovery.md` | Recovery behaviour read from source (not executed). |
| `../packages/contracts` | TypeScript tests over the files above. |

Surfaces: `tool-schemas`, `hook-abi`, `manifests`, `state-schema`, `ledger`.

## Rerun for a new pin

1. Clone upstream as read-only data, outside this repo, and check out the new commit:

   ```
   git clone --filter=blob:none --no-checkout https://github.com/NousResearch/hermes-agent /path/to/hermes-agent
   git -C /path/to/hermes-agent checkout <new-sha>
   ```

2. Regenerate. The `-I` flag keeps the current directory off the Python path:

   ```
   python3 -I contracts/extract/run.py /path/to/hermes-agent
   ```

3. Update `upstream/pin.json`: set `commit` to the full 40-character SHA, `commitDate`, and `stateSchemaVersion` to the `schema_version` in `contracts/upstream/state-schema.json`.
4. Run `npm run check`. Read each failure; it names what to do:
   - A new table fails "has a decision for every extracted table". Add it to `table-decisions.json` using guide section 2.4.
   - A removed table fails "no decision for a table that no longer exists". Remove its decision.
   - A new hook name fails the hook test. Review it, make sure the port dispatches it, then add it to `known-hooks.json`. A removed hook also fails; remove it from the list.
   - A changed schema version fails the version test. Read the migration notes next to `SCHEMA_VERSION` in `hermes_state_common.py` first.
   - A tool schema that is no longer a valid object with `name`, `description` and `parameters` fails the schema test.
5. Review `git diff contracts/upstream`. The diff is the list of what upstream changed.
6. Commit the generated files, the pin and any decision changes together.

The tests also check that every generated file records the pinned commit, so a bump without a rerun fails.

## Rules the extractors follow

- **Tool schemas.** Calls of `registry.register(...)` and `ctx.register_tool(...)` whose `schema` resolves to a literal. The resolver follows module-level names, dict and list displays, `**` unpacking, `+` on strings, f-strings of literals, `list(...)` and `"sep".join(...)`. Anything else is listed under `non_literal` with its name (when known), file, line and reason. Those schemas are built at run time (functions, config) and need a different method.
- **Hook ABI.** Names come from the `VALID_HOOKS` set in `hermes_cli/plugins.py`. Kwargs come from call sites whose function name contains `hook` and that pass a literal hook name. For `**payload` the extractor reads dict literals assigned to that name in the same function; otherwise the site is marked `dynamic_kwargs`. Hooks with `call_sites: 0` are dispatched in a way the extractor cannot see; their kwargs are not known.
- **Manifests.** Every `plugin.yaml` outside `tests/`, parsed with a small YAML subset parser (`extract/manifests.py`). Class: `python` if any `*.py` sits beside it, else `js` if any `*.js/.mjs/.cjs/.ts` or `package.json`, else `portable`. This is a guess from file extensions.
- **State schema.** `SCHEMA_VERSION`, and every `CREATE TABLE` / `CREATE VIRTUAL TABLE` string. The state.db scope is `hermes_state*.py` at the repo root plus `gateway/delivery_ledger.py`, `hermes_cli/backup_restore.py` and `tools/async_delegation.py` (see `STATE_DB_FILES_EXPLICIT`). Tables in other files are listed under `other_stores` and need no decision. If upstream starts creating a state.db table from a file outside this list, the extractor does not see it; check the `other_stores.files` hints (`state.db`) when you bump the pin.
- **Ledger.** CHECK status sets, unique constraints, primary keys, foreign keys, and every `UPDATE <table> SET status=...` found in SQL strings, with the statuses in the same WHERE clause as the "from" set. Initial inserts are not traced.
