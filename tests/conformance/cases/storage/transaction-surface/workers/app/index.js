// What a transaction() callback's DurableObjectTransaction has (plan 1.30):
// in workerd its prototype is its own, below Object.prototype, with get,
// put, delete, list, deleteAll, the alarm methods and rollback(); it has no
// own properties, no transaction(), transactionSync() or sync(), and no `kv`
// or `sql`. celld's shared a base with ctx.storage, so it had all of them.
// The root storage's own surface is `storage/storage-surface`.
import { DurableObject } from "cloudflare:workers";

const MEMBERS = [
  "get", "put", "delete", "list", "deleteAll", "getAlarm", "setAlarm", "deleteAlarm",
  "rollback", "transaction", "transactionSync", "sync", "kv", "sql",
];

function chain(value) {
  const out = [];
  for (let proto = Object.getPrototypeOf(value); proto !== Object.prototype; proto = Object.getPrototypeOf(proto))
    out.push(Object.getOwnPropertyNames(proto).sort());
  return out;
}

export class Obj extends DurableObject {
  async probe() {
    const storage = this.ctx.storage;
    let out;
    await storage.transaction(async (txn) => {
      out = {
        chain: chain(txn),
        own: Reflect.ownKeys(txn).map(String),
        members: Object.fromEntries(MEMBERS.map((name) => [name, typeof txn[name]])),
        hasSql: "sql" in txn,
        isStorage: txn instanceof storage.constructor,
      };
      // The view still works.
      await txn.put("k", "v");
      out.read = await txn.get("k");
      txn.rollback();
    });
    out.afterRollback = (await storage.get("k")) ?? null;
    return out;
  }
}

export default {
  async fetch(request, env) {
    return Response.json(await env.OBJ.getByName("x").probe());
  },
};
