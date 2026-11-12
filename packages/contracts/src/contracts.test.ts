import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DECISIONS,
  OWNERS,
  loadKnownHooks,
  loadPin,
  loadSurface,
  loadTableDecisions,
  missingFrom,
  type HookAbiSurface,
  type LedgerSurface,
  type ManifestsSurface,
  type StateSchemaSurface,
  type ToolSchemasSurface,
} from "./index.ts";

const pin = loadPin();
const state = loadSurface<StateSchemaSurface>("state-schema");
const hooks = loadSurface<HookAbiSurface>("hook-abi");
const toolSurface = loadSurface<ToolSchemasSurface>("tool-schemas");
const manifests = loadSurface<ManifestsSurface>("manifests");
const ledger = loadSurface<LedgerSurface>("ledger");
const decisions = loadTableDecisions();

describe("pin", () => {
  it("names a full commit SHA that starts with the short SHA", () => {
    assert.match(pin.commit, /^[0-9a-f]{40}$/);
  });

  it("matches the commit every extracted surface was read from", () => {
    for (const [name, s] of Object.entries({ state, hooks, toolSurface, manifests, ledger })) {
      assert.equal(s.upstream_commit, pin.commit, `${name}: regenerate with contracts/extract/run.py after moving the pin`);
    }
  });
});

describe("state schema", () => {
  it("has a decision for every extracted table", () => {
    const missing = missingFrom(state.tables.map((t) => t.name), Object.keys(decisions));
    assert.deepEqual(missing, [], `add these tables to contracts/table-decisions.json: ${missing.join(", ")}`);
  });

  it("has no decision for a table that no longer exists", () => {
    const stale = missingFrom(Object.keys(decisions), state.tables.map((t) => t.name));
    assert.deepEqual(stale, [], `remove these from contracts/table-decisions.json: ${stale.join(", ")}`);
  });

  it("uses only the allowed decisions and owners, and gives each a note", () => {
    for (const [name, d] of Object.entries(decisions)) {
      assert.ok(DECISIONS.includes(d.decision), `${name}: decision ${d.decision}`);
      assert.ok(OWNERS.includes(d.owner), `${name}: owner ${d.owner}`);
      assert.ok(d.note.length > 0, `${name}: empty note`);
    }
  });

  it("reads the schema version the pin records", () => {
    assert.equal(state.schema_version, pin.stateSchemaVersion);
  });

  it("finds the tables the guide section 2.4 names", () => {
    assert.equal(state.counts["ordinary_in_schema_sql"], 17);
    assert.equal(state.counts["virtual_fts5"], 2);
    const outbox = state.tables.find((t) => t.name === "delivery_obligations");
    assert.ok(outbox?.created_lazily, "delivery_obligations is created on first use");
  });
});

describe("hook ABI", () => {
  it("matches the reviewed hook list", () => {
    const known = loadKnownHooks();
    const added = missingFrom(hooks.hook_names, known);
    const removed = missingFrom(known, hooks.hook_names);
    assert.deepEqual(added, [], `new upstream hooks need review, then add to contracts/known-hooks.json: ${added.join(", ")}`);
    assert.deepEqual(removed, [], `hooks gone upstream, remove from contracts/known-hooks.json: ${removed.join(", ")}`);
  });

  it("has sorted, unique hook names", () => {
    assert.deepEqual(hooks.hook_names, [...new Set(hooks.hook_names)].sort());
  });
});

describe("tool schemas", () => {
  it("lists at least one literal schema", () => {
    assert.ok(toolSurface.tools.length > 0);
  });

  it("gives every literal schema a name, a description and a parameters object", () => {
    for (const t of toolSurface.tools) {
      const where = `${t.file}:${t.line}`;
      const s = t.schema;
      assert.ok(s !== null && typeof s === "object" && !Array.isArray(s), `${where}: schema is not an object`);
      assert.equal(typeof s["name"], "string", `${where}: name`);
      assert.ok((s["name"] as string).length > 0, `${where}: empty name`);
      assert.equal(s["name"], t.name, `${where}: schema name differs from the registered name`);
      assert.equal(typeof s["description"], "string", `${where}: description`);
      const p = s["parameters"];
      assert.ok(p !== null && typeof p === "object" && !Array.isArray(p), `${where}: parameters is not an object`);
      assert.equal((p as Record<string, unknown>)["type"], "object", `${where}: parameters.type`);
    }
  });

  it("round-trips through JSON unchanged", () => {
    for (const t of toolSurface.tools) {
      assert.deepEqual(JSON.parse(JSON.stringify(t.schema)), t.schema);
    }
  });

  it("registers each name once", () => {
    const names = toolSurface.tools.map((t) => t.name);
    assert.equal(new Set(names).size, names.length);
  });
});

describe("manifests", () => {
  it("parses every bundled plugin.yaml and classes it", () => {
    assert.ok(manifests.manifests.length > 0);
    for (const m of manifests.manifests) {
      assert.ok(m.parsed, `${m.path} did not parse`);
      assert.ok(["portable", "js", "python"].includes(m.class), `${m.path}: class ${m.class}`);
    }
  });
});

describe("ledger", () => {
  it("keeps the status sets and uniqueness rules the guide relies on", () => {
    const adm = ledger.tables["session_admissions"];
    assert.deepEqual(adm?.status_set, ["queued", "started", "terminal", "unknown"]);
    assert.deepEqual(adm?.unique_constraints, [["admission_id"], ["principal_id", "target_session_id", "request_id"]]);
    const wex = ledger.tables["worker_executions"];
    assert.deepEqual(wex?.status_set, ["registered", "running", "terminal", "unknown"]);
    assert.deepEqual(wex?.primary_key, ["execution_id"]);
    const rec = ledger.tables["worker_receipts"];
    assert.deepEqual(rec?.primary_key, ["execution_id", "sequence"]);
  });

  it("has a decision for each ledger table", () => {
    for (const name of ["session_admissions", "worker_executions", "worker_receipts"]) {
      assert.ok(decisions[name], name);
    }
  });
});
