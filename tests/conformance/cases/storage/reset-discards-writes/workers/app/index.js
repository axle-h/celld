// Which writes a Durable Object reset discards (plan 1.30). In workerd an
// object's writes run in an implicit transaction that commits when the turn
// ends, and `blockConcurrencyWhile()` commits it before its callback runs; a
// reset (`/abort/*`: ctx.abort(); `/block/*`: a blockConcurrencyWhile()
// callback that throws) rolls back what was not committed. So a write the
// reset follows in the same turn is gone, even one whose put() was awaited or
// whose cursor was read, and one before a timer, before a block, or in a
// committed transaction() survives. celld committed every write at once. A
// fresh stub then reads what the new instance finds.
import { DurableObject } from "cloudflare:workers";

const message = (error) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class Obj extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS t (v TEXT)");
  }

  async run(kind, scenario) {
    const storage = this.ctx.storage;
    const { sql, kv } = storage;
    const insert = (v) => sql.exec("INSERT INTO t VALUES (?)", v);
    // The reset, or inside a block the failure that resets.
    const fail = () => {
      if (kind === "abort") this.ctx.abort("reset");
      throw new Error("reset");
    };
    const reset = () => this.ctx.blockConcurrencyWhile(async () => fail());
    const resetNow = () => (kind === "abort" ? fail() : reset());
    switch (scenario) {
      case "sql-sync": insert("a"); await resetNow(); break;
      case "sql-microtask": insert("a"); await Promise.resolve(); await resetNow(); break;
      case "sql-timer": insert("a"); await sleep(20); await resetNow(); break;
      case "put-noawait": storage.put("a", 1); await resetNow(); break;
      case "put-await": await storage.put("a", 1); await resetNow(); break;
      case "kv-sync": kv.put("a", 1); await resetNow(); break;
      case "cursor-unconsumed": {
        sql.exec("INSERT INTO t VALUES ('a'), ('b') RETURNING v").next();
        await resetNow();
        break;
      }
      case "cursor-consumed": {
        sql.exec("INSERT INTO t VALUES ('a'), ('b') RETURNING v").toArray();
        await resetNow();
        break;
      }
      case "block-before": insert("a"); await reset(); break;
      case "block-inside":
        await this.ctx.blockConcurrencyWhile(async () => { insert("a"); fail(); });
        break;
      case "block-inside-timer":
        await this.ctx.blockConcurrencyWhile(async () => { insert("a"); await sleep(20); fail(); });
        break;
      case "block-before-timer":
        insert("a");
        await sleep(20);
        await this.ctx.blockConcurrencyWhile(async () => { insert("b"); fail(); });
        break;
      case "sql-then-put-await": insert("a"); await storage.put("b", 1); await resetNow(); break;
      case "txsync": storage.transactionSync(() => insert("a")); await resetNow(); break;
      case "tx-async": await storage.transaction(async () => { insert("a"); }); await resetNow(); break;
    }
    return "returned";
  }

  final() {
    return {
      rows: this.ctx.storage.sql.exec("SELECT v FROM t ORDER BY v").toArray().map((row) => row.v),
      kv: [...this.ctx.storage.kv.list()].map(([key]) => key),
    };
  }
}

export default {
  async fetch(request, env) {
    const [, kind, scenario] = new URL(request.url).pathname.split("/");
    const name = `${kind}-${scenario}`;
    let run;
    try {
      run = await env.OBJ.getByName(name).run(kind, scenario);
    } catch (error) {
      run = "threw " + message(error);
    }
    // A fresh stub: the one above is broken with the object.
    return Response.json({ run, final: await env.OBJ.getByName(name).final() });
  },
};
