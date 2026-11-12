/** Unit tests with a fake actor context (no rivetkit). */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { FencedError, RivetHost, SidecarError, type ActorLike, type DbLike } from "./index.ts";

function fakeDb(raw = new DatabaseSync(":memory:")): DbLike {
  const db: DbLike = {
    execute: async (q, ...a) => raw.prepare(q).all(...(a as never[])).map((r) => ({ ...r })),
    transaction: async (cb) => {
      raw.exec("BEGIN");
      try {
        const r = await cb(db);
        raw.exec("COMMIT");
        return r;
      } catch (e) {
        raw.exec("ROLLBACK");
        throw e;
      }
    },
  };
  return db;
}

function fakeActor(db = fakeDb(), id = "a1") {
  const scheduled: { at: number; action: string; args: unknown[]; id: string }[] = [];
  const cancelled: string[] = [];
  let kept = 0;
  const c: ActorLike = {
    actorId: id,
    key: ["k"],
    db,
    schedule: {
      at: async (at, action, ...args) => {
        const sid = `s${scheduled.length + 1}`;
        scheduled.push({ at, action, args, id: sid });
        return sid;
      },
      cancel: async (sid) => (cancelled.push(sid), true),
    },
    keepAwake: (p) => (kept++, p),
    abortSignal: new AbortController().signal,
  };
  return { c, scheduled, cancelled, kept: () => kept, db };
}

describe("RivetHost with a fake context", () => {
  it("raises the epoch at each activation", async () => {
    const f = fakeActor();
    assert.equal((await RivetHost.activate(f.c)).epoch(), 1);
    assert.equal((await RivetHost.activate(f.c)).epoch(), 2);
  });

  it("tx rolls back on throw and is durable on success", async () => {
    const f = fakeActor();
    const h = await RivetHost.activate(f.c);
    await h.tx((s) => s.exec("CREATE TABLE t (n INTEGER)"));
    await h.tx((s) => s.exec("INSERT INTO t VALUES (1)"));
    await assert.rejects(h.tx((s) => { s.exec("INSERT INTO t VALUES (2)"); throw new Error("x"); }));
    assert.deepEqual(await f.db.execute("SELECT n FROM t"), [{ n: 1 }]);
    assert.deepEqual((await h.tx((s) => s.exec("SELECT n FROM t"))).map((r) => ({ ...r })), [{ n: 1 }]);
  });

  it("keeps AUTOINCREMENT high-water marks across a reload", async () => {
    const f = fakeActor();
    const h = await RivetHost.activate(f.c);
    await h.tx((s) => s.exec("CREATE TABLE q (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)"));
    await h.tx((s) => s.exec("INSERT INTO q (v) VALUES ('a')"));
    await h.tx((s) => s.exec("DELETE FROM q"));
    const again = await RivetHost.activate(f.c);
    const id = await again.tx((s) => {
      s.exec("INSERT INTO q (v) VALUES ('b')");
      return Number(s.exec("SELECT last_insert_rowid() AS id")[0]?.["id"]);
    });
    assert.equal(id, 2, "the mirror does not reuse id 1");
    assert.deepEqual(await f.db.execute("SELECT id, v FROM q"), [{ id: 2, v: "b" }], "mirror and durable ids agree");
    await again.tx((s) => s.exec("DELETE FROM q WHERE id = ?", id));
    assert.deepEqual(await f.db.execute("SELECT id FROM q"), [], "deleting the returned id deletes the durable row");
  });

  it("reloads an FTS5 index without replaying its shadow tables", async () => {
    const f = fakeActor();
    const h = await RivetHost.activate(f.c);
    await h.tx((s) => s.exec("CREATE VIRTUAL TABLE search_fts USING fts5(body)"));
    await h.tx((s) => s.exec("INSERT INTO search_fts (body) VALUES ('hello durable world')"));
    const again = await RivetHost.activate(f.c);
    const hits = await again.tx((s) => s.exec("SELECT body FROM search_fts WHERE search_fts MATCH 'durable'"));
    assert.deepEqual(hits.map((r) => ({ ...r })), [{ body: "hello durable world" }]);
    await again.tx((s) => s.exec("INSERT INTO search_fts (body) VALUES ('second row')"));
    const third = await RivetHost.activate(f.c);
    const all = await third.tx((s) => s.exec("SELECT body FROM search_fts WHERE search_fts MATCH 'row OR durable' ORDER BY rowid"));
    assert.deepEqual(all.map((r) => r["body"]), ["hello durable world", "second row"]);
  });

  it("reloads an FTS5 index whose text is in an external content table", async () => {
    const f = fakeActor();
    const h = await RivetHost.activate(f.c);
    await h.tx((s) => {
      s.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)");
      s.exec("CREATE VIRTUAL TABLE notes_fts USING fts5(body, content='notes', content_rowid='id')");
      s.exec("INSERT INTO notes (id, body) VALUES (7, 'external durable text')");
      s.exec("INSERT INTO notes_fts (rowid, body) VALUES (7, 'external durable text')");
    });
    const again = await RivetHost.activate(f.c);
    const hits = await again.tx((s) => s.exec("SELECT rowid, body FROM notes_fts WHERE notes_fts MATCH 'durable'"));
    assert.deepEqual(hits.map((r) => ({ ...r })), [{ rowid: 7, body: "external durable text" }]);
  });

  it("reloads an FTS5 table whose CREATE text has a comment that looks like a content option", async () => {
    const f = fakeActor();
    const h = await RivetHost.activate(f.c);
    await h.tx((s) => {
      s.exec("CREATE VIRTUAL TABLE docs USING fts5(body /* content='notes' */)");
      s.exec("INSERT INTO docs (body) VALUES ('commented durable text')");
    });
    const again = await RivetHost.activate(f.c);
    const hits = await again.tx((s) => s.exec("SELECT body FROM docs WHERE docs MATCH 'durable'"));
    assert.deepEqual(hits.map((r) => r["body"]), ["commented durable text"]);
  });

  it("keeps the FTS4 language id of each row across a reload", async () => {
    const f = fakeActor();
    const h = await RivetHost.activate(f.c);
    await h.tx((s) => {
      s.exec("CREATE VIRTUAL TABLE langs USING fts4(body, languageid='lid')");
      s.exec("INSERT INTO langs (body, lid) VALUES ('bonjour durable', 4)");
    });
    const again = await RivetHost.activate(f.c);
    const hits = await again.tx((s) => s.exec("SELECT body FROM langs WHERE langs MATCH 'durable' AND lid = 4"));
    assert.deepEqual(hits.map((r) => r["body"]), ["bonjour durable"]);
  });

  it("reloads a contentless FTS5 index", async () => {
    const f = fakeActor();
    const h = await RivetHost.activate(f.c);
    await h.tx((s) => {
      s.exec("CREATE VIRTUAL TABLE bare USING fts5(body, content='')");
      s.exec("INSERT INTO bare (rowid, body) VALUES (3, 'no stored text')");
    });
    const again = await RivetHost.activate(f.c);
    const hits = await again.tx((s) => s.exec("SELECT rowid FROM bare WHERE bare MATCH 'stored'"));
    assert.deepEqual(hits.map((r) => r["rowid"]), [3]);
    await again.tx((s) => s.exec("INSERT INTO bare (rowid, body) VALUES (4, 'stored again')"));
    const third = await RivetHost.activate(f.c);
    const all = await third.tx((s) => s.exec("SELECT rowid FROM bare WHERE bare MATCH 'stored' ORDER BY rowid"));
    assert.deepEqual(all.map((r) => r["rowid"]), [3, 4]);
  });

  it("reloads rows whose foreign key points at a table that sorts later", async () => {
    const f = fakeActor();
    const h = await RivetHost.activate(f.c);
    await h.tx((s) => {
      s.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY)");
      s.exec("CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), body TEXT)");
      s.exec("INSERT INTO sessions (id) VALUES ('s1')");
      s.exec("INSERT INTO messages (session_id, body) VALUES ('s1', 'hi')");
    });
    const again = await RivetHost.activate(f.c);
    assert.deepEqual(await again.tx((s) => s.exec("SELECT body FROM messages").map((r) => r["body"])), ["hi"]);
    await assert.rejects(again.tx((s) => s.exec("INSERT INTO messages (session_id, body) VALUES ('nope', 'x')")), /FOREIGN KEY/);
  });

  it("reloads an ordinary table whose name looks like an FTS shadow table", async () => {
    const f = fakeActor();
    const h = await RivetHost.activate(f.c);
    await h.tx((s) => {
      // An external content table that happens to be named like an FTS4 shadow table of `notes`.
      s.exec("CREATE TABLE notes_segments (id INTEGER PRIMARY KEY, body TEXT)");
      s.exec("CREATE VIRTUAL TABLE notes USING fts5(body, content='notes_segments', content_rowid='id')");
      s.exec("INSERT INTO notes_segments (id, body) VALUES (1, 'durable note')");
      s.exec("INSERT INTO notes (rowid, body) VALUES (1, 'durable note')");
    });
    const again = await RivetHost.activate(f.c);
    assert.deepEqual(await again.tx((s) => s.exec("SELECT body FROM notes_segments").map((r) => r["body"])), ["durable note"]);
    assert.deepEqual(await again.tx((s) => s.exec("SELECT rowid FROM notes WHERE notes MATCH 'durable'").map((r) => r["rowid"])), [1]);
  });

  it("reloads an FTS4 external content table, which needs its content table first", async () => {
    const f = fakeActor();
    const h = await RivetHost.activate(f.c);
    await h.tx((s) => {
      s.exec("CREATE TABLE zdocs (id INTEGER PRIMARY KEY, body TEXT)"); // named to sort after its virtual table
      s.exec("CREATE VIRTUAL TABLE adocs USING fts4(content='zdocs') /* the columns come from zdocs */");
      s.exec("INSERT INTO zdocs (id, body) VALUES (1, 'durable note')");
      s.exec("INSERT INTO adocs (docid, body) VALUES (1, 'durable note')");
    });
    const again = await RivetHost.activate(f.c);
    assert.deepEqual(await again.tx((s) => s.exec("SELECT docid FROM adocs WHERE adocs MATCH 'durable'").map((r) => r["docid"])), [1]);
  });

  it("rejects an async tx callback", async () => {
    const h = await RivetHost.activate(fakeActor().c);
    await assert.rejects(h.tx((async () => 1) as never), TypeError);
  });

  it("a newer activation fences the older one", async () => {
    const f = fakeActor();
    const old = await RivetHost.activate(f.c);
    await RivetHost.activate(f.c);
    await assert.rejects(old.tx((s) => s.exec("CREATE TABLE z (n)")), FencedError);
  });

  it("handleWake re-arms before the handler runs", async () => {
    const f = fakeActor();
    let now = 1000;
    const h = await RivetHost.activate(f.c, { now: () => now, retryDelayMs: 500 });
    await h.arm(new Date(1100), "obl");
    let armedWhenHandled = 0;
    h.onWake(async () => {
      armedWhenHandled = f.scheduled.length;
      throw new Error("fails");
    });
    now = 1200;
    await assert.rejects(h.handleWake("obl"), /fails/);
    assert.equal(armedWhenHandled, 2); // the retry timer existed before the handler
    assert.equal(f.scheduled[1]!.at, 1700);
    assert.deepEqual(f.cancelled, ["s1"]);
    assert.deepEqual(await h.handleWake("missing"), []);
  });

  it("startTask uses keepAwake once per name", async () => {
    const f = fakeActor();
    const h = await RivetHost.activate(f.c);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const a = h.startTask("turn", () => gate);
    const b = h.startTask("turn", () => gate);
    assert.equal(a, b);
    assert.equal(f.kept(), 1);
    release();
    await a;
  });

  it("sidecar sends the epoch and maps errors", async () => {
    const seen: Request[] = [];
    const h = await RivetHost.activate(fakeActor().c, {
      sidecars: {
        ok: { fetch: async (r) => (seen.push(r), Response.json({ v: 1 })) },
        bad: { fetch: async () => new Response("no", { status: 500 }) },
      },
    });
    assert.deepEqual(await h.sidecar("ok").call("m", {}), { v: 1 });
    assert.equal(seen[0]!.headers.get("x-hermesd-epoch"), "1");
    await assert.rejects(h.sidecar("bad").call("m", {}), SidecarError);
    await assert.rejects(h.sidecar("none").call("m", {}), /no sidecar/);
  });

  it("fetch honors an aborted signal", async () => {
    const h = await RivetHost.activate(fakeActor().c, { fetch: async () => new Response("x") });
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(h.fetch(new Request("http://x/"), ac.signal));
  });
});
