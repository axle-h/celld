// Refusals only, for names no workerd client sends.
//
// celld's service bindings and ctx.exports stubs always have workerd's
// test hook, getRpcMethodForTestOnly(name), which sends any name. A stub
// answers Object.prototype's names locally, so only the hook (or a peer)
// can send them, and the receiver refuses them before any user code runs.
//
// A KV, Queue or D1 binding calls a runtime cell through a Durable Object
// stub, which user code can reach. The cell answers only the methods the
// binding calls, directly; its other methods serve its own events.
import { WorkerEntrypoint } from "cloudflare:workers";

const reached = () => "REACHED";

// The error a refused call rejects with, or what it answered instead.
async function refused(fn) {
  try {
    return { answered: await fn() };
  } catch (error) {
    return `${error.name}: ${error.message}`;
  }
}

export class Local extends WorkerEntrypoint {
  toString() {
    return reached();
  }

  hasOwnProperty() {
    return reached();
  }
}

const NAMES = [
  "constructor", "fetch", "connect", "toString", "valueOf", "hasOwnProperty",
  "isPrototypeOf", "__proto__", "__defineGetter__", "__lookupGetter__",
];

async function hook(stub) {
  const out = [];
  for (const name of NAMES) out.push([name, await refused(() => stub.getRpcMethodForTestOnly(name)(1))]);
  return Object.fromEntries(out);
}

export default {
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    if (path === "/hook") {
      return Response.json({
        local: await hook(ctx.exports.Local),
        entry: await hook(env.ENTRY),
        object: await hook(env.OBJECT),
        // A property read of a reserved name.
        localGet: await refused(() => ctx.exports.Local.getRpcMethodForTestOnly("constructor")),
      });
    }
    if (path === "/runtime") {
      const kv = env.KV._stub;
      const queue = env.QUEUE._stub;
      const db = env.DB._stub;
      return Response.json({
        kvSweep: await refused(() => kv.__kvSweep({ now: 0, limit: 1 })),
        kvMetrics: await refused(() => kv.__kvMetrics({ now: 0 })),
        kvOpen: await refused(() => kv._open()),
        kvAlarm: await refused(() => kv.alarm()),
        // An allowed method, read rather than called, or called through a path.
        kvGetRead: await refused(() => kv.__kvGet),
        kvGetPath: await refused(() => kv.__kvGet.call(null, { keys: [] })),
        queuePurge: await refused(() => queue._purge()),
        queuePause: await refused(() => queue._setPaused(true)),
        queuePeek: await refused(() => queue._peek(1)),
        queueSettle: await refused(() => queue._settle({})),
        queueAlarm: await refused(() => queue.alarm()),
        queueCtx: await refused(() => queue.ctx),
        dbAlarm: await refused(() => db.alarm()),
        dbCtx: await refused(() => db.ctx),
      });
    }
    return new Response("not found", { status: 404 });
  },
};
