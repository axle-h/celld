// A cursor's rowsWritten counts what its own statement wrote. celld's reads
// the connection's count when the cursor ends, so a write made while a
// SELECT's cursor is open shows up in the SELECT's count (plan 1.55).
import { DurableObject } from "cloudflare:workers";

export class Obj extends DurableObject {
  probe() {
    const sql = this.ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS t (a)");
    sql.exec("INSERT INTO t VALUES (1), (2)");
    const plain = sql.exec("SELECT a FROM t");
    plain.toArray();
    const interleaved = sql.exec("SELECT a FROM t");
    this.ctx.storage.kv.put("k", "v");
    interleaved.toArray();
    const write = sql.exec("UPDATE t SET a = a + 1");
    write.toArray();
    return {
      plain: plain.rowsWritten,
      interleaved: interleaved.rowsWritten,
      write: write.rowsWritten,
    };
  }
}

export default {
  async fetch(request, env) {
    return Response.json(await env.OBJ.getByName("x").probe());
  },
};
