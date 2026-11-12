import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, it } from "node:test";
import { canonicalImage } from "./canonical.ts";
import { loadPlainActors } from "./plain.ts";
import { epochFloor } from "./apply.ts";
import { readActors } from "./read-actors.ts";
import { readStateDb } from "./read-db.ts";
import { buildSampleStateDb } from "./sample.ts";
import { LEDGER_TABLES, createUpstreamDb, normaliseSql, readDbFile, upstreamDdl, upstreamTableNames } from "./schema.ts";
import { writeStateDb } from "./write-db.ts";

// Import and export without a platform: the rules of guide 6.4 and of
// `contracts/upstream-recovery.md`. The simulator run is in migration.test.ts.

let dir: string;
let source: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "state-port-"));
  source = join(dir, "source.db");
  buildSampleStateDb(source);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const NOW = 1_700_100_000_000;
const rows = (path: string, sql: string): Array<Record<string, unknown>> => {
  return readDbFile(path, (db) => db.prepare(sql).all().map((r) => ({ ...r })));
};

describe("upstream DDL", () => {
  it("has the 17 ordinary tables that upstream makes in its schema script", () => {
    assert.equal(upstreamTableNames().length, 17);
    assert.ok(!upstreamTableNames().includes("delivery_obligations"));
  });

  it("reads WAL frames that were never checkpointed, and leaves the file and its WAL as they were", () => {
    const source = join(dir, "live.db");
    const writer = createUpstreamDb(source);
    writer.prepare("INSERT INTO schema_version (version) VALUES (?)").run(32);
    writer.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    writer.exec("PRAGMA wal_autocheckpoint = 0");
    writer.prepare("INSERT INTO sessions (id, source, started_at) VALUES (?, ?, ?)").run("only-in-wal", "cli", 1);
    // Copy the file and its WAL while the writer still holds them: the -shm is not copied.
    const path = join(dir, "snapshot.db");
    copyFileSync(source, path);
    copyFileSync(`${source}-wal`, `${path}-wal`);
    writer.close();
    assert.ok(!existsSync(`${path}-shm`));
    const sha = (p: string): string => createHash("sha256").update(readFileSync(p)).digest("hex");
    const before = { db: sha(path), wal: sha(`${path}-wal`) };
    const { image } = readStateDb(path);
    assert.deepEqual(image.sessions.map((x) => x.actor), ["only-in-wal"]);
    assert.ok(existsSync(`${path}-wal`), "the WAL is still there");
    assert.deepEqual({ db: sha(path), wal: sha(`${path}-wal`) }, before, "the file and its WAL are byte for byte as they were");
  });

  it("reads a WAL snapshot from a directory it cannot write to, and leaves it as it was", (t) => {
    if (process.getuid?.() === 0) return t.skip("root ignores directory permissions");
    const source = join(dir, "live.db");
    const writer = createUpstreamDb(source);
    writer.prepare("INSERT INTO schema_version (version) VALUES (?)").run(32);
    writer.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    writer.exec("PRAGMA wal_autocheckpoint = 0");
    writer.prepare("INSERT INTO sessions (id, source, started_at) VALUES (?, ?, ?)").run("only-in-wal", "cli", 1);
    const locked = join(dir, "locked");
    mkdirSync(locked);
    const path = join(locked, "state.db");
    copyFileSync(source, path);
    copyFileSync(`${source}-wal`, `${path}-wal`);
    writer.close();
    const sha = (p: string): string => createHash("sha256").update(readFileSync(p)).digest("hex");
    const before = { db: sha(path), wal: sha(`${path}-wal`) };
    // No -shm, and none can be made: a read-only connection cannot open the file here.
    chmodSync(locked, 0o555);
    try {
      const { image } = readStateDb(path);
      assert.deepEqual(image.sessions.map((x) => x.actor), ["only-in-wal"]);
    } finally {
      chmodSync(locked, 0o755);
    }
    assert.deepEqual(readdirSync(locked).sort(), ["state.db", "state.db-wal"]);
    assert.deepEqual({ db: sha(path), wal: sha(`${path}-wal`) }, before);
  });

  it("reads a clean copy of a WAL state.db, one with no -shm file beside it", () => {
    const source = join(dir, "live.db");
    const db = createUpstreamDb(source);
    db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(32);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.close();
    // A person copies state.db alone: the file is still in WAL mode, and its -shm is not copied.
    const path = join(dir, "clean.db");
    copyFileSync(source, path);
    assert.ok(!existsSync(`${path}-shm`));
    const { report } = readStateDb(path);
    assert.ok(report);
    readDbFile(path, (db) => assert.throws(() => db.exec("CREATE TABLE y (x)"), /readonly/));
  });

  it("makes a file whose table text is upstream's, byte for byte", () => {
    const path = join(dir, "fresh.db");
    createUpstreamDb(path).close();
    const reference = new DatabaseSync(":memory:");
    for (const t of upstreamDdl().tables) reference.exec(t.sql);
    const stored = (p: string): Array<{ name: string; sql: string }> => {
      return readDbFile(p, (db) => db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string; sql: string }>);
    };
    const want = reference.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    assert.deepEqual(stored(path), want);
    for (const t of upstreamDdl().tables) {
      const got = stored(path).find((x) => x.name === t.name)!;
      assert.equal(normaliseSql(got.sql), normaliseSql(t.sql), t.name);
    }
  });
});

describe("import", () => {
  it("splits one profile into a profile image and one session image for each chain", () => {
    const { image, report } = readStateDb(source);
    assert.deepEqual(image.sessions.map((s) => [s.actor, s.currentSession, s.sessions.map((x) => x.id)]), [
      ["s1", "s1", ["s1"]],
      ["s2", "s2b", ["s2", "s2b"]],
    ]);
    assert.deepEqual(image.sessions.map((s) => s.messages.map((m) => m.id)), [[1, 2, 3, 4], [5, 6, 7, 8]]);
    assert.deepEqual(image.profile.conversation_generations.map((r) => [r.source, r.generation]), [["cli", 1], ["telegram", 3]]);
    assert.equal(image.profile.upstreamEpoch, 7);
    assert.equal(report.ledger, "keep");
  });

  it("drops the FTS markers of state_meta and counts the tables it does not carry", () => {
    const { image, report } = readStateDb(source);
    assert.deepEqual(image.profile.state_meta, [{ key: "profile_label", value: "work" }]);
    assert.deepEqual(report.metaDropped.sort(), ["fts_storage_version", "fts_trigram_ready"]);
    assert.deepEqual(report.dropped, { session_turn_leases: 1, compression_locks: 1, gateway_routing: 1 });
  });

  it("turns a started admission into unknown, as upstream does at the next owner start", () => {
    const { image, report } = readStateDb(source);
    const s2 = image.sessions.find((s) => s.actor === "s2")!;
    assert.deepEqual(s2.session_admissions.map((a) => [a.seq, a.status]), [[3, "terminal"], [4, "unknown"]]);
    assert.equal(report.startedToUnknown, 1);
    assert.equal(s2.session_admissions[1]!.owner_epoch, 7, "the owner epoch stays");
  });

  it("leaves the ledger out when asked, as `hermes sessions recover` does", () => {
    const { image, report } = readStateDb(source, { ledger: "exclude" });
    for (const s of image.sessions) {
      assert.deepEqual([s.session_admissions, s.worker_executions, s.worker_receipts], [[], [], []]);
    }
    assert.equal(image.profile.upstreamEpoch, null);
    assert.equal(report.dropped.runtime_epoch, 1);
    assert.equal(report.dropped.session_admissions, 4);
  });

  it("refuses a file at another schema version", () => {
    const db = new DatabaseSync(source);
    db.exec("UPDATE schema_version SET version = 31");
    db.close();
    assert.throws(() => readStateDb(source), /schema version 31/);
  });

  it("refuses a file that is not a Hermes state.db", () => {
    const path = join(dir, "other.db");
    new DatabaseSync(path).close();
    assert.throws(() => readStateDb(path), /not a Hermes state.db/);
  });
});

describe("export", () => {
  const roundtrip = (mode: "full" | "partial", from = readStateDb(source).image) => {
    const actors = loadPlainActors(from, 2);
    const out = join(dir, `${mode}.db`);
    const report = writeStateDb(out, readActors(actors.sources), { mode, now: NOW });
    actors.close();
    return { out, report };
  };

  it("a full export keeps the ledger and the state it came from", () => {
    const { out, report } = roundtrip("full");
    assert.equal(report.fts, true);
    assert.deepEqual(rows(out, "SELECT seq, status, outcome FROM session_admissions ORDER BY seq"), [
      { seq: 1, status: "terminal", outcome: "completed" },
      { seq: 2, status: "terminal", outcome: "completed" },
      { seq: 3, status: "terminal", outcome: "completed" },
      { seq: 4, status: "unknown", outcome: null },
    ]);
    assert.equal(rows(out, "SELECT COUNT(*) AS n FROM worker_receipts")[0]!.n, 1);
    assert.equal(rows(out, "SELECT COUNT(*) AS n FROM messages")[0]!.n, 8);
    assert.deepEqual(rows(out, "SELECT version FROM schema_version"), [{ version: 32 }]);
    assert.deepEqual(rows(out, "PRAGMA foreign_key_check"), []);
  });

  it("a partial export leaves out the four ledger tables and keeps conversation_generations", () => {
    const { out, report } = roundtrip("partial");
    for (const t of LEDGER_TABLES) assert.equal(rows(out, `SELECT COUNT(*) AS n FROM ${t}`)[0]!.n, 0, t);
    assert.equal(report.epoch, null);
    assert.deepEqual(rows(out, "SELECT source, generation FROM conversation_generations ORDER BY source"), [
      { source: "cli", generation: 1 },
      { source: "telegram", generation: 3 },
    ]);
    assert.equal(rows(out, "SELECT COUNT(*) AS n FROM messages")[0]!.n, 8);
  });

  it("never deletes or overwrites an export that another writer finished first", () => {
    const actors = loadPlainActors(readStateDb(source).image, 2);
    const image = readActors(actors.sources);
    actors.close();
    const out = join(dir, "raced.db");
    const sessions = image.sessions;
    // The other writer finishes while this one is building.
    Object.defineProperty(image, "sessions", { get: () => (writeFileSync(out, "theirs"), sessions) });
    assert.throws(() => writeStateDb(out, image, { mode: "full", now: NOW }), /exists/);
    assert.equal(readFileSync(out, "utf8"), "theirs");
    assert.deepEqual(readdirSync(dir).filter((f) => f.startsWith("raced.db.")), [], "no temp file is left");
  });

  it("writes the epoch floor: at least the highest epoch of the actors, of the rows and of the file", () => {
    const image = readStateDb(source).image;
    assert.equal(epochFloor(image), 7, "the file said 7");
    const high = loadPlainActors(image, 12);
    const out = join(dir, "high.db");
    const report = writeStateDb(out, readActors(high.sources), { mode: "full", now: NOW });
    high.close();
    assert.equal(report.epoch, 12);
    assert.deepEqual(rows(out, "SELECT singleton, epoch, instance_id FROM runtime_epoch"), [{ singleton: 1, epoch: 12, instance_id: "hermesd-port-export" }]);
    // And never lower than the file it came from.
    assert.equal(roundtrip("full").report.epoch, 7);
  });

  it("makes the FTS tables again and finds the text", () => {
    const { out } = roundtrip("full");
    assert.equal(rows(out, "SELECT COUNT(*) AS n FROM messages_fts WHERE messages_fts MATCH 'rollout'")[0]!.n, 3);
    assert.equal(rows(out, "SELECT COUNT(*) AS n FROM messages_fts_trigram WHERE messages_fts_trigram MATCH 'igration'")[0]!.n, 3);
  });

  it("writes an in-flight turn as a started admission and the lease and lock as expired", () => {
    const image = readStateDb(source).image;
    const actors = loadPlainActors(image, 9);
    const s1 = actors.sql.sessions.get("s1")!;
    // A turn of the port is open: its admission is started with the actor's epoch.
    s1.exec(
      `INSERT INTO session_admissions (admission_id, request_id, principal_id, target_session_id, lineage_json, payload_json, payload_digest, intent, status, owner_epoch, generation)
       VALUES ('adm-new', 'new-1', 'user-1', 's1', '{}', '{"input":"go"}', 'd', 'queue', 'started', 9, 5)`,
    );
    s1.exec("INSERT INTO turns (id, admission_id, status, horizon, started_at) VALUES ('turn-5', 5, 'open', 0, ?)", NOW - 5_000);
    // A compaction of s2 has started.
    const s2 = actors.sql.sessions.get("s2")!;
    s2.exec("INSERT INTO compaction_link (child_id, parent_id, cutoff_message_id, status, schema_version, data) VALUES ('s2c', 's2b', 8, 'started', 32, '{}')");
    const live = readActors(actors.sources);
    actors.close();

    const out = join(dir, "inflight.db");
    writeStateDb(out, live, { mode: "full", now: NOW });
    assert.deepEqual(rows(out, "SELECT status, owner_epoch FROM session_admissions WHERE request_id = 'new-1'"), [{ status: "started", owner_epoch: 9 }]);
    const lease = rows(out, "SELECT conversation_id, holder, acquired_at, expires_at FROM session_turn_leases");
    assert.equal(lease.length, 1);
    assert.equal(lease[0]!.conversation_id, "s1");
    assert.ok(Number(lease[0]!.expires_at) < NOW / 1000, "expired");
    assert.ok(Number(lease[0]!.acquired_at) <= Number(lease[0]!.expires_at));
    const lock = rows(out, "SELECT session_id, expires_at FROM compression_locks");
    assert.equal(lock.length, 1);
    assert.equal(lock[0]!.session_id, "s2b");
    assert.ok(Number(lock[0]!.expires_at) < NOW / 1000, "expired");
    // The live lease and lock of the source file are not carried.
    assert.equal(rows(out, "SELECT COUNT(*) AS n FROM session_turn_leases WHERE holder = 'gateway-old'")[0]!.n, 0);
    // The epoch floor covers the started row.
    assert.equal(rows(out, "SELECT epoch FROM runtime_epoch")[0]!.epoch, 9);

    // Not in a partial export: no admission, but the expired rows are.
    const partial = join(dir, "inflight-partial.db");
    writeStateDb(partial, live, { mode: "partial", now: NOW });
    assert.equal(rows(partial, "SELECT COUNT(*) AS n FROM session_admissions")[0]!.n, 0);
    assert.equal(rows(partial, "SELECT COUNT(*) AS n FROM session_turn_leases")[0]!.n, 1);
  });

  it("gives new ids when two actors use the same one, and keeps the order in each session", () => {
    const image = readStateDb(source).image;
    const actors = loadPlainActors(image);
    // s1 goes on writing and takes id 5, which s2 has.
    actors.sql.sessions.get("s1")!.exec("INSERT INTO messages (id, session_id, role, content, timestamp, message_uid) VALUES (5, 's1', 'user', 'again', 1, 'm-new-1')");
    actors.sql.sessions.get("s1")!.exec("INSERT INTO messages (id, session_id, role, content, timestamp, message_uid) VALUES (6, 's1', 'assistant', 'ok', 2, 'm-new-2')");
    const live = readActors(actors.sources);
    actors.close();
    const out = join(dir, "collide.db");
    const report = writeStateDb(out, live, { mode: "full", now: NOW });
    assert.deepEqual(report.renumbered.messages, ["s2"], "s1 comes first and keeps its ids");
    const got = rows(out, "SELECT id, session_id, message_uid FROM messages ORDER BY id");
    assert.equal(new Set(got.map((r) => r.id)).size, got.length);
    const s2 = got.filter((r) => r.session_id === "s2" || r.session_id === "s2b").map((r) => r.message_uid);
    assert.deepEqual(s2, ["m-5", "m-6", "m-7", "m-8"], "the order inside the chain is kept");
  });

  it("makes a session row for a queued admission whose session does not exist yet", () => {
    const image = readStateDb(source).image;
    const actors = loadPlainActors(image);
    actors.sql.sessions.get("s1")!.exec(
      `INSERT INTO session_admissions (admission_id, request_id, principal_id, target_session_id, lineage_json, payload_json, payload_digest, intent, status)
       VALUES ('adm-q', 'q-1', 'user-1', 's9', '{}', '{"input":"hi"}', 'd', 'queue', 'queued')`,
    );
    const live = readActors(actors.sources);
    actors.close();
    const out = join(dir, "stub.db");
    const report = writeStateDb(out, live, { mode: "full", now: NOW });
    assert.deepEqual(report.stubSessions, ["s9"]);
    assert.deepEqual(rows(out, "PRAGMA foreign_key_check"), []);
  });

  it("never overwrites a file, and leaves no half-made file after an error", () => {
    const image = readStateDb(source).image;
    assert.throws(() => writeStateDb(source, image, { mode: "full", now: NOW }), /never overwrites/);
    const bad = structuredClone(image);
    bad.sessions[1]!.sessions.push({ ...bad.sessions[0]!.sessions[0]! }); // the same session in two actors
    const out = join(dir, "bad.db");
    assert.throws(() => writeStateDb(out, bad, { mode: "full", now: NOW }), /two actors/);
    assert.throws(() => rows(out, "SELECT 1"), /unable to open|no such/i);
  });

  it("an export that is read again is the same image", () => {
    const first = readStateDb(source).image;
    const { out } = roundtrip("full", first);
    const second = readStateDb(out).image;
    assert.deepEqual(canonicalImage(second), canonicalImage(first));
  });
});
