// Proxies of objects holding celld's marker keys, on each path that
// serialises a script's values. workerd treats a Proxy by the prototype
// chain it presents: over RPC one presenting a plain object crosses as a
// stub and any other is refused; storage, a Queue and a Worker Loader env
// refuse every Proxy with V8's DataCloneError. (A service binding to another
// Worker is rpc/marker-shaped-proxies-service.)
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { PROXY_NAMES, object, plainVerdict } from "#marker-shaped";

const each = async (fn) => {
  const out = {};
  for (const name of PROXY_NAMES) {
    try {
      const value = await fn(name);
      out[name] = typeof value === "function" ? "stub" : value;
    } catch (error) {
      out[name] = `${error.name}: ${error.message}`;
    }
  }
  return out;
};

export class Echo extends WorkerEntrypoint {
  probe(arg) {
    return typeof arg.v === "function" ? "stub" : plainVerdict(arg.v);
  }
}

export class Obj extends DurableObject {
  async put(name) {
    await this.ctx.storage.put(name, { v: object(name) });
    return "stored";
  }
}

export default {
  async fetch(request, env, ctx) {
    return Response.json({
      params: await each((name) => ctx.exports.Echo.probe({ v: object(name) })),
      paramsLift: await each((name) => ctx.exports.Echo.probe({ lift: new Headers(), v: object(name) })),
      storage: await each((name) => env.OBJ.getByName("a").put(name)),
      queue: await each(async (name) => {
        await env.QUEUE.send({ v: object(name) }, { contentType: "v8" });
        return "sent";
      }),
      loader: await each(async (name) => {
        const worker = env.LOADER.load({
          compatibilityDate: "2026-01-01",
          mainModule: "main.js",
          modules: { "main.js": "export default { fetch() { return new Response('loaded'); } };" },
          env: { v: object(name) },
        });
        return (await worker.getEntrypoint().fetch("http://loaded/")).text();
      }),
    });
  },
};
