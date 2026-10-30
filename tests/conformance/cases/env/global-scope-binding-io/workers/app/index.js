// A binding's I/O at module scope, where `env` from cloudflare:workers holds
// the bindings: workerd refuses it with its global-scope error, thrown by the
// call itself, and nothing it asked for happens. `/state` shows that later:
// the KV key is absent, and the service and the Durable Object counted no
// call. A var and a Durable Object id still read.
import { env, DurableObject } from "cloudflare:workers";
import { connect } from "cloudflare:sockets";

const outcomes = {};
const attempt = (name, call) => {
  try {
    const value = call();
    if (value instanceof Promise) {
      outcomes[name] = "pending";
      value.then(
        () => { outcomes[name] = "resolved"; },
        (error) => { outcomes[name] = `rejected ${error.constructor.name}: ${error.message}`; });
    } else {
      outcomes[name] = typeof value;
    }
  } catch (error) {
    outcomes[name] = `threw ${error.constructor.name}: ${error.message}`;
  }
};
const CHILD = {
  compatibilityDate: "2026-09-04",
  mainModule: "main.js",
  modules: { "main.js": "export default { fetch() { return new Response(); } };" },
};
const id = env.OBJ.idFromName("a");
attempt("var", () => env.GREETING);
attempt("kvGet", () => env.KV.get("k"));
attempt("kvPut", () => env.KV.put("k", "from module scope"));
attempt("kvDelete", () => env.KV.delete("k"));
attempt("kvList", () => env.KV.list());
attempt("serviceFetch", () => env.BACK.fetch("http://back/hit"));
attempt("serviceRpc", () => env.BACK.hit());
attempt("objectGet", () => env.OBJ.get(id));
attempt("objectCall", () => env.OBJ.get(id).bump());
attempt("loaderGet", () => env.LOADER.get("child", () => CHILD));
attempt("loaderLoad", () => env.LOADER.load(CHILD));
attempt("fetch", () => fetch("http://127.0.0.1:1/"));
attempt("connect", () => connect("127.0.0.1:1"));
attempt("webSocket", () => new WebSocket("ws://127.0.0.1:1/"));
// A continuation module scope queued runs before the Worker starts, still in
// global scope.
Promise.resolve().then(() => attempt("kvPutLater", () => env.KV.put("later", "x")));

export class Obj extends DurableObject {
  async bump() {
    const count = ((await this.ctx.storage.get("count")) ?? 0) + 1;
    await this.ctx.storage.put("count", count);
    return count;
  }

  async count() {
    return (await this.ctx.storage.get("count")) ?? 0;
  }
}

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname === "/state") {
      return Response.json({
        kv: await env.KV.get("k"),
        kvLater: await env.KV.get("later"),
        back: await (await env.BACK.fetch("http://back/count")).json(),
        object: await env.OBJ.get(env.OBJ.idFromName("a")).count(),
      });
    }
    return Response.json(outcomes);
  },
};
