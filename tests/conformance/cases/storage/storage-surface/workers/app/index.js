// ctx.storage's prototype in workerd is DurableObjectStorage's own, below
// Object.prototype, without rollback() and with the point-in-time recovery
// methods (getBookmarkForTime, getCurrentBookmark,
// onNextSessionRestoreBookmark), which celld does not implement; both
// classes carry Symbol.toStringTag (plan 1.59, found by 1.30).
import { DurableObject } from "cloudflare:workers";

function chain(value) {
  const out = [];
  for (let proto = Object.getPrototypeOf(value); proto !== Object.prototype; proto = Object.getPrototypeOf(proto))
    out.push(Object.getOwnPropertyNames(proto).sort());
  return out;
}

export class Obj extends DurableObject {
  async probe() {
    const storage = this.ctx.storage;
    const out = { chain: chain(storage), tag: Object.prototype.toString.call(storage) };
    await storage.transaction(async (txn) => {
      out.transactionTag = Object.prototype.toString.call(txn);
    });
    return out;
  }
}

export default {
  async fetch(request, env) {
    return Response.json(await env.OBJ.getByName("x").probe());
  },
};
