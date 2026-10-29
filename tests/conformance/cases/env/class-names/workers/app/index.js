// Each runtime object's constructor name and Object.prototype.toString tag.
// celld names its Queue binding `Queue` (workerd `WorkerQueue`) and its
// cursor `SqlCursor` (`Cursor`), and its objects carry no toStringTag
// (plan 1.55).
import { DurableObject } from "cloudflare:workers";

const name = (value) => [value.constructor.name, Object.prototype.toString.call(value)];

export class Obj extends DurableObject {
  names() {
    const storage = this.ctx.storage;
    return {
      ctx: name(this.ctx),
      storage: name(storage),
      sql: name(storage.sql),
      cursor: name(storage.sql.exec("SELECT 1")),
      kv: name(storage.kv),
      facets: name(this.ctx.facets),
    };
  }
}

export default {
  async fetch(request, env) {
    return Response.json({
      namespace: name(env.OBJ),
      id: name(env.OBJ.idFromName("x")),
      kv: name(env.KV),
      queue: name(env.QUEUE),
      object: await env.OBJ.getByName("x").names(),
    });
  },
};
