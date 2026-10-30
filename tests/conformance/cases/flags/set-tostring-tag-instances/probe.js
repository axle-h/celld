// What Object.prototype.toString() gives the objects that are not instances
// of an API class in celld, with and without set_tostring_tag: workerd's
// global scope, ctx, bindings, Durable Object state and RPC handles are
// instances of jsg classes, whose prototypes are tagged with the flag; in
// celld they are plain objects, functions, Promises or Errors. Also the API
// globals celld lacks or adds, and jsg's mark of a runtime class.
import { DurableObject, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";

const kind = (value) => Object.prototype.toString.call(value);

class Target extends RpcTarget {
  ping() { return "pong"; }
}

export class Things extends WorkerEntrypoint {
  target() { return new Target(); }
}

export class Thing extends DurableObject {
  kinds() {
    return {
      state: kind(this.ctx),
      storage: kind(this.ctx.storage),
      sql: kind(this.ctx.storage.sql),
      id: kind(this.ctx.id),
      object: kind(this),
    };
  }
}

const GLOBALS = [
  "Body", "Crypto", "FetchEvent", "Navigator", "Performance", "PerformanceEntry",
  "PromiseRejectionEvent", "ScheduledEvent", "ServiceWorkerGlobalScope",
  "TailEvent", "TraceEvent", "WorkerGlobalScope", "DigestStream", "Temporal",
];

export default {
  async fetch(request, env, ctx) {
    const stub = env.OBJECT.get(env.OBJECT.idFromName("x"));
    const promise = env.SELF.target();
    const target = await promise;
    return Response.json({
      global: kind(globalThis),
      ctx: kind(ctx),
      service: kind(env.SELF),
      kv: kind(env.KV),
      r2: kind(env.R2),
      queue: kind(env.QUEUE),
      namespace: kind(env.OBJECT),
      objectId: kind(env.OBJECT.idFromName("x")),
      ...(await stub.kinds()),
      exception: kind(new DOMException("x")),
      stub: kind(target),
      property: kind(env.SELF.target),
      promise: kind(promise),
      caches: kind(caches),
      crypto: kind(crypto),
      navigator: kind(navigator),
      scheduler: kind(scheduler),
      cloudflare: kind(Cloudflare),
      console: kind(console),
      process: kind(process),
      globals: Object.fromEntries(GLOBALS.map((name) => [name, typeof globalThis[name]])),
      runtimeClass: Object.getOwnPropertySymbols(Request.prototype)
        .map((symbol) => Symbol.keyFor(symbol) ?? String(symbol)),
    });
  },
};
