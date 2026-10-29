// A Durable Object's ctx and every object it hands out keep their state
// private, and none can be constructed: their own properties are workerd's,
// and `new value.constructor()` throws "Illegal constructor". celld's once
// held the object's scope, a cursor's host id and read-ahead row, and a
// facet manager's object as plain properties (plan 1.49).
import { DurableObject } from "cloudflare:workers";

function shape(value) {
  let construct;
  try {
    new value.constructor();
    construct = "constructed";
  } catch (error) {
    construct = `${error.name}: ${error.message}`;
  }
  return { own: Reflect.ownKeys(value).map(String), construct };
}

export class Obj extends DurableObject {
  async probe() {
    const storage = this.ctx.storage;
    storage.sql.exec("CREATE TABLE IF NOT EXISTS t (a)");
    storage.sql.exec("INSERT INTO t VALUES (1), (2)");
    const cursor = storage.sql.exec("SELECT a FROM t");
    storage.kv.put("k", "v");
    const out = {
      ctx: shape(this.ctx),
      storage: shape(storage),
      sql: shape(storage.sql),
      cursor: shape(cursor),
      kv: shape(storage.kv),
      list: shape(storage.kv.list()),
      facets: shape(this.ctx.facets),
      id: shape(this.ctx.id),
    };
    await storage.transaction(async (txn) => {
      out.transaction = shape(txn);
    });
    // The parts still work.
    out.rows = cursor.toArray();
    out.columns = cursor.columnNames;
    out.rowsRead = cursor.rowsRead;
    out.kvGet = storage.kv.get("k");
    out.listed = [...storage.kv.list()];
    return out;
  }
}

export default {
  async fetch(request, env) {
    return Response.json(await env.OBJ.getByName("x").probe());
  },
};
