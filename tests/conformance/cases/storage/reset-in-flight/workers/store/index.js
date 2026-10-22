// An object reset while another of its events is still running (plan 1.14).
// Event "a" resets the object: its blockConcurrencyWhile() callback throws
// (/block-throws), or it calls ctx.abort() (/abort), inside a transaction
// (/abort-in-transaction) or inside transactionSync() (/abort-in-sync-transaction).
// Event "b" started first (the fetch handler calls "a" only once "b" runs) and
// tries to write once "a" is done. In workerd the reset breaks the object:
// both events fail with the reset's error, even "a", which caught it, and the
// old instance's storage refuses every later write. The transcript records
// how each event settled and what the replacement instance reads.
import { DurableObject } from "cloudflare:workers";

const message = (error) => (error instanceof Error ? error.message : String(error));

export class Store extends DurableObject {
  bRunning = Promise.withResolvers();
  aReady = Promise.withResolvers();
  bReady = Promise.withResolvers();
  aSettled = Promise.withResolvers();

  async bStarted() {
    await this.bRunning.promise;
  }

  async a(scenario) {
    const ctx = this.ctx;
    try {
      if (scenario === "block-throws") {
        await ctx.blockConcurrencyWhile(async () => {
          this.aReady.resolve();
          await this.bReady.promise;
          throw new Error("block threw");
        });
      } else if (scenario === "abort") {
        this.aReady.resolve();
        await this.bReady.promise;
        ctx.abort(new Error("aborted"));
      } else if (scenario === "abort-in-transaction") {
        await ctx.storage.transaction(async () => {
          await ctx.storage.put("a", "a");
          this.aReady.resolve();
          await this.bReady.promise;
          ctx.abort(new Error("aborted"));
        });
      } else {
        this.aReady.resolve();
        await this.bReady.promise;
        ctx.storage.transactionSync(() => {
          ctx.storage.kv.put("a", "a");
          ctx.abort(new Error("aborted"));
        });
      }
      return "a:ok";
    } catch (error) {
      return "a:caught:" + message(error);
    } finally {
      this.aSettled.resolve();
    }
  }

  async b() {
    const storage = this.ctx.storage;
    this.bRunning.resolve();
    await this.aReady.promise;
    this.bReady.resolve();
    await this.aSettled.promise;
    const late = [
      () => storage.put("late", "late"),
      () => storage.kv.put("late2", "late2"),
      () => storage.sql.exec("CREATE TABLE late (v TEXT)"),
      () => storage.transactionSync(() => storage.kv.put("late3", "late3")),
      () => storage.transaction(async () => storage.put("late4", "late4")),
    ];
    for (const write of late) {
      try {
        await write();
      } catch {}
    }
    return "b:ok";
  }

  async final() {
    const storage = this.ctx.storage;
    const keys = ["a", "late", "late2", "late3", "late4"];
    const values = Object.fromEntries(
      await Promise.all(keys.map(async (key) => [key, (await storage.get(key)) ?? null])),
    );
    const tables = storage.sql
      .exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'late'")
      .toArray().length;
    return { ...values, lateTable: tables > 0 };
  }
}

export default {
  async fetch(request, env) {
    const scenario = new URL(request.url).pathname.slice(1);
    if (!["block-throws", "abort", "abort-in-transaction", "abort-in-sync-transaction"].includes(scenario))
      return new Response("not found", { status: 404 });
    try {
      const store = env.STORE.getByName(scenario);
      // "a" is called once "b" runs: two calls sent together can start in
      // either order.
      const b = store.b();
      await store.bStarted();
      const settled = await Promise.allSettled([b, store.a(scenario)]);
      const events = Object.fromEntries(settled.map((result, i) => [
        i === 0 ? "b" : "a",
        result.status === "fulfilled" ? result.value : "rejected: " + message(result.reason),
      ]));
      // A fresh stub: the one above can be broken with the object.
      return Response.json({ events, final: await env.STORE.getByName(scenario).final() });
    } catch (error) {
      return Response.json({ error: message(error) }, { status: 500 });
    }
  },
};
