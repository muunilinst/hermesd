// A tiny test worker. It exports a Durable Object class that uses the adapter.
// The tests load it in workerd through Miniflare. "./adapter.js" is
// src/index.ts with its types removed.
import { DurableObject } from "cloudflare:workers";
import { CloudflareHost } from "./adapter.js";

export class TestObject extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.host = new CloudflareHost(ctx, {});
    this.host.onAlarm(async (keys) => {
      await this.host.tx((sql) => {
        for (const k of keys) sql.exec("INSERT INTO alarm_log (key, at) VALUES (?, ?)", k, Date.now());
      });
      for (const k of keys) await this.host.disarm(k);
    });
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS rows (v TEXT)");
      ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS alarm_log (key TEXT, at INTEGER)");
    });
  }

  async alarm() {
    await this.host.handleAlarm();
  }

  async fetch(request) {
    const url = new URL(request.url);
    const h = this.host;
    switch (url.pathname) {
      case "/epoch":
        return Response.json({ epoch: h.epoch(), id: h.id() });
      case "/append": {
        const v = url.searchParams.get("v");
        await h.tx((sql) => sql.exec("INSERT INTO rows (v) VALUES (?)", v));
        await h.commit();
        return Response.json({ ok: true });
      }
      case "/tx-throw": {
        try {
          await h.tx((sql) => {
            sql.exec("INSERT INTO rows (v) VALUES ('a')");
            sql.exec("INSERT INTO rows (v) VALUES ('b')");
            throw new Error("boom");
          });
        } catch (e) {
          return Response.json({ threw: String(e.message) });
        }
        return Response.json({ threw: null });
      }
      case "/tx-async": {
        try {
          await h.tx(async (sql) => sql.exec("INSERT INTO rows (v) VALUES ('async')"));
        } catch (e) {
          return Response.json({ threw: e.name });
        }
        return Response.json({ threw: null });
      }
      case "/rows":
        return Response.json(await h.tx((sql) => sql.exec("SELECT v FROM rows ORDER BY rowid")));
      case "/arm": {
        const at = Number(url.searchParams.get("at"));
        await h.arm(new Date(at), url.searchParams.get("key"));
        return Response.json({ alarm: await this.ctx.storage.getAlarm() });
      }
      case "/alarm":
        return Response.json({ alarm: await this.ctx.storage.getAlarm() });
      case "/alarm-log":
        return Response.json(await h.tx((sql) => sql.exec("SELECT key FROM alarm_log ORDER BY rowid")));
      case "/abort":
        // Reset the object. The next request builds a new instance.
        this.ctx.abort("test restart");
        return new Response("unreachable");
      default:
        return new Response("not found", { status: 404 });
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const name = url.searchParams.get("name") ?? "t1";
    const stub = env.TEST_OBJECT.get(env.TEST_OBJECT.idFromName(name));
    return stub.fetch(request);
  },
};
