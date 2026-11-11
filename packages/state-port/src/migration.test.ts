import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, it } from "node:test";
import { NODE_CONFIGS, createLoopWorld, type LoopWorld, type LoopWorldOptions } from "@hermesd/faults";
import type { Sql, SqlRow, SqlValue } from "@hermesd/host";
import { createSessionActor, SUPPORTED_TOOLS, type ModelStep } from "@hermesd/session-actor";
import { applyProfileImage, applySessionImage, epochFloor } from "./apply.ts";
import { canonicalImage } from "./canonical.ts";
import type { StateImage } from "./image.ts";
import { loadPlainActors } from "./plain.ts";
import { readActors, type ActorSources } from "./read-actors.ts";
import { readStateDb } from "./read-db.ts";
import { buildSampleStateDb } from "./sample.ts";
import { normaliseSql, openReadOnly, upstreamDdl } from "./schema.ts";
import { writeStateDb } from "./write-db.ts";

// The migration test of guide 6.4, as far as it can run here:
//
//   1. build a state.db from upstream's DDL;
//   2. split it into the profile actor and its session actors;
//   3. run 3 turns in the port, one of which calls session_search;
//   4. export the rows into a fresh state.db;
//   5. check the schema, the rows, and that a new import gives the same state;
//   6. `hermes chat --resume` on the file. This step cannot run here. See the
//      skipped test at the end and contracts/resume-check.sh.

const NOW = 1_700_100_000_000;

let dir: string;
let source: string;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "migration-"));
  source = join(dir, "source.db");
  buildSampleStateDb(source);
});
after(() => rmSync(dir, { recursive: true, force: true }));

const sqlOf = (w: LoopWorld, key: string): Sql => ({ exec: (q: string, ...p: SqlValue[]): SqlRow[] => w.b.query(key, q, ...p) });

/** The actors of the world as sources for an export. */
function sourcesOf(w: LoopWorld): ActorSources {
  const src = (key: string) => ({ query: (q: string, ...p: SqlValue[]) => w.b.query(key, q, ...p), epoch: w.b.epochOf(key) });
  return { profile: src("profile"), sessions: [{ actor: "s1", source: src("s1") }, { actor: "s2", source: src("s2") }] };
}

/** Split the file into the actors of the world. The host raises its owner epochs to the floor of the file. */
function seed(w: LoopWorld, image: StateImage): void {
  w.b.defineActor("s2", (h) =>
    createSessionActor(h, { clock: w.b.clock, runtime: w.config, migrations: w.code.migrations, loop: { replyTarget: "gateway", profileTarget: "actor:profile" } }),
  );
  // The world already ran the profile actor once. Stop it, so that the next activation takes the raised epoch.
  for (const key of ["profile", "s1", "s2"]) w.b.crash(key);
  applyProfileImage(sqlOf(w, "profile"), image);
  for (const s of image.sessions) applySessionImage(sqlOf(w, s.actor), s);
  const floor = epochFloor(image);
  for (const key of ["profile", "s1", "s2"]) w.b.query(key, "UPDATE host_state SET owner_epoch = ? WHERE id = 1", floor);
}

const OPTS: Partial<LoopWorldOptions> = { loop: { tools: [...SUPPORTED_TOOLS, "session_search"] } };

const THREE_TURNS: ModelStep[] = [
  { reply: "Noted: the canary goes first." },
  { toolCalls: [{ name: "session_search", arguments: { query: "migration window" } }] },
  { reply: "The migration window is Friday night." },
  { reply: "All three turns are recorded." },
];

/** The schema of a file without the FTS tables and their shadow tables. */
function schemaOf(path: string): Array<{ type: string; name: string; sql: string }> {
  const db = openReadOnly(path);
  try {
    return (db.prepare("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'messages_fts%' AND name NOT LIKE 'sqlite_%' ORDER BY type, name").all() as Array<{ type: string; name: string; sql: string }>).map((r) => ({ ...r }));
  } finally {
    db.close();
  }
}

function rows(path: string, sql: string): Array<Record<string, unknown>> {
  const db = openReadOnly(path);
  try {
    return db.prepare(sql).all().map((r) => ({ ...r }));
  } finally {
    db.close();
  }
}

for (const cfg of NODE_CONFIGS) {
  describe(`migration: state.db to the port and back [node/${cfg.mode}]`, () => {
    it("import, 3 turns with session_search, export, same schema, same rows, same state on re-import", async () => {
      const w = await createLoopWorld(cfg, { script: THREE_TURNS, ...OPTS });
      try {
        // 1 and 2: import.
        const { image: imported, report } = readStateDb(source);
        assert.equal(report.startedToUnknown, 1);
        seed(w, imported);
        assert.deepEqual(await w.b.call("profile", "rebuild_index"), { rebuilt: 8 }, "the search index is made again from the rows");

        // 3: three turns. The second one calls session_search; the answer comes from rows that were imported into another actor.
        for (const [i, text] of ["Plan the canary", "When is the migration window?", "Summarise"].entries()) {
          await w.send(text, `new-${i + 1}`);
          await w.until(() => w.replies.length === i + 1, `reply ${i + 1}`);
        }
        await w.until(() => w.rows("outbox").length === 0, "the outbox is empty");
        w.assertConsistent();
        assert.deepEqual(w.replies.map((r) => r.text), ["Noted: the canary goes first.", "The migration window is Friday night.", "All three turns are recorded."]);
        const toolRow = w.rows("messages", "tool_name = 'session_search'")[0]!;
        const found = JSON.parse(String(toolRow.content)) as { count: number; results: Array<{ session: string }> };
        assert.ok(found.count >= 1);
        assert.equal(found.results[0]!.session, "s2", "found in a chain that another actor owns");
        // The turns resumed the imported conversation: the first request has its history.
        const first = w.model.recorder.requests[0]!.body as { messages: Array<{ content: string }> };
        assert.ok(first.messages.some((m) => m.content === "What is the plan for the kubernetes rollout?"));

        // 4: export, full and partial.
        const live = readActors(sourcesOf(w));
        const full = join(dir, `full-${cfg.mode}.db`);
        const partial = join(dir, `partial-${cfg.mode}.db`);
        const fullReport = writeStateDb(full, live, { mode: "full", now: NOW });
        const partialReport = writeStateDb(partial, live, { mode: "partial", now: NOW });

        // 5a: the schema is upstream's. Tables byte for byte against a database made from the DDL, indexes the same.
        const reference = new DatabaseSync(":memory:");
        for (const t of upstreamDdl().tables) reference.exec(t.sql);
        for (const i of upstreamDdl().indexes) reference.exec(i.sql);
        const want = (reference.prepare("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type, name").all() as Array<{ type: string; name: string; sql: string }>).map((r) => ({ ...r }));
        for (const path of [full, partial]) {
          const got = schemaOf(path);
          assert.deepEqual(got, want, `${path}: schema differs from upstream's DDL`);
          // And the text is the text of the contract file.
          for (const t of upstreamDdl().tables) assert.equal(normaliseSql(got.find((x) => x.name === t.name)!.sql), normaliseSql(t.sql), t.name);
        }
        assert.equal(want.filter((r) => r.type === "table").length, 17);
        assert.deepEqual(rows(full, "SELECT version FROM schema_version"), [{ version: 32 }]);

        // 5b: the rows.
        assert.deepEqual(rows(full, "SELECT id FROM sessions ORDER BY id").map((r) => r.id), ["s1", "s2", "s2b"]);
        assert.equal(rows(full, "SELECT COUNT(*) AS n FROM messages WHERE session_id = 's1'")[0]!.n, 4 + 8, "4 imported, 8 new rows from 3 turns");
        assert.equal(rows(full, "SELECT COUNT(*) AS n FROM messages")[0]!.n, 16);
        assert.equal(rows(full, "SELECT COUNT(*) AS n FROM messages WHERE tool_name = 'session_search'")[0]!.n, 1);
        assert.equal(rows(full, "SELECT COUNT(*) AS n FROM messages WHERE tool_calls IS NOT NULL")[0]!.n, 1);
        assert.equal(new Set(rows(full, "SELECT id FROM messages").map((r) => r.id)).size, 16, "ids are unique across actors");
        assert.deepEqual(fullReport.renumbered, { messages: ["s2"], admissions: ["s2"] }, "s2 used ids that s1 took");
        // Admissions: upstream's own statuses. 2 old and 3 new for s1, one finished and one unknown for s2.
        const adm = rows(full, "SELECT request_id, target_session_id, status, outcome FROM session_admissions ORDER BY seq");
        assert.deepEqual(adm.map((a) => [a.request_id, a.status, a.outcome]), [
          ["old-1", "terminal", "completed"],
          ["old-2", "terminal", "completed"],
          ["new-1", "terminal", "completed"],
          ["new-2", "terminal", "completed"],
          ["new-3", "terminal", "completed"],
          ["old-3", "terminal", "completed"],
          ["old-4", "unknown", null],
        ]);
        assert.equal(rows(full, "SELECT COUNT(*) AS n FROM worker_receipts")[0]!.n, 1);
        assert.equal(rows(full, "SELECT COUNT(*) AS n FROM session_turn_leases")[0]!.n, 0, "the live lease of the source file is not carried");
        assert.equal(rows(full, "SELECT COUNT(*) AS n FROM compression_locks")[0]!.n, 0, "the live lock of the source file is not carried");
        // The epoch floor: at least the highest owner epoch the actors used, and at least the epoch of the file.
        const used = Math.max(w.b.epochOf("profile"), w.b.epochOf("s1"), w.b.epochOf("s2"));
        assert.ok(used > 7, "activation raised the epoch above the floor of the file");
        assert.equal(fullReport.epoch, used);
        assert.deepEqual(rows(full, "SELECT epoch FROM runtime_epoch"), [{ epoch: used }]);
        assert.ok(Number(rows(full, "SELECT MAX(owner_epoch) AS m FROM session_admissions")[0]!.m) <= used);
        // Search in the regenerated FTS tables.
        assert.equal(fullReport.fts, true);
        assert.ok(Number(rows(full, "SELECT COUNT(*) AS n FROM messages_fts WHERE messages_fts MATCH 'canary'")[0]!.n) >= 1);
        // The partial file: no ledger, but the generations.
        for (const t of ["runtime_epoch", "session_admissions", "worker_executions", "worker_receipts"]) {
          assert.equal(rows(partial, `SELECT COUNT(*) AS n FROM ${t}`)[0]!.n, 0, t);
        }
        assert.equal(partialReport.epoch, null);
        assert.equal(rows(partial, "SELECT COUNT(*) AS n FROM conversation_generations")[0]!.n, 2);
        assert.equal(rows(partial, "SELECT COUNT(*) AS n FROM messages")[0]!.n, 16);

        // 5c: import the file again. The state is the same.
        const again = readStateDb(full);
        assert.equal(again.report.startedToUnknown, 0);
        const reloaded = loadPlainActors(again.image);
        try {
          assert.deepEqual(canonicalImage(readActors(reloaded.sources)), canonicalImage(live));
          assert.deepEqual(canonicalImage(again.image), canonicalImage(live));
        } finally {
          reloaded.close();
        }
        // The partial file gives the same conversations without the ledger.
        assert.deepEqual(canonicalImage(readStateDb(partial).image, { ledger: false }), canonicalImage(live, { ledger: false }));
      } finally {
        w.b.close();
      }
    });

    it("a turn that is still running is exported as a started admission, and the lease is expired", async () => {
      const w = await createLoopWorld(cfg, { script: [{ hold: "slow", reply: "late answer" }], ...OPTS });
      try {
        seed(w, readStateDb(source).image);
        await w.send("Plan the canary", "slow-1");
        await w.until(() => w.rows("session_admissions", "request_id = 'slow-1'")[0]?.status === "started", "the turn started");
        await w.until(() => w.rows("pending_call", "status = 'pending'").length === 1, "the model call is in flight");
        const live = readActors(sourcesOf(w));
        const out = join(dir, `inflight-${cfg.mode}.db`);
        const report = writeStateDb(out, live, { mode: "full", now: NOW });
        // Upstream will see a started row of an older epoch and mark it unknown at its next start.
        const started = rows(out, "SELECT status, owner_epoch, generation FROM session_admissions WHERE request_id = 'slow-1'");
        assert.equal(started.length, 1);
        assert.equal(started[0]!.status, "started");
        assert.equal(started[0]!.owner_epoch, w.b.epochOf("s1"));
        assert.ok(Number(started[0]!.generation) > 0);
        assert.ok(Number(rows(out, "SELECT epoch FROM runtime_epoch")[0]!.epoch) >= Number(started[0]!.owner_epoch), "the floor covers the started row");
        const lease = rows(out, "SELECT conversation_id, expires_at FROM session_turn_leases");
        assert.equal(lease.length, 1);
        assert.ok(Number(lease[0]!.expires_at) < NOW / 1000, "expired");
        assert.equal(report.mode, "full");
        // The same file read again: the started row is unknown, as upstream would make it.
        const back = readStateDb(out);
        assert.equal(back.report.startedToUnknown, 1, "the new turn; the started row of the source file is already unknown");
        w.model.release("slow");
      } finally {
        w.b.close();
      }
    });
  });
}

describe("the last step of the migration test", () => {
  // Guide 6.4: "run hermes chat --resume on it. If upstream can resume what the
  // port wrote, the rows are interchangeable."
  it(
    "hermes chat --resume reads the exported file",
    { skip: "Upstream Hermes may not be executed in this environment. Run contracts/resume-check.sh on your own machine with the exported file." },
    () => {
      // Intentionally empty: the check is the script.
    },
  );
});
