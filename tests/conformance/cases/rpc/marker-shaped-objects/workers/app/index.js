// Objects V8's serializer writes as plain objects whatever prototype they
// claim, each holding every key celld's markers use. workerd refuses each
// over RPC and in a Worker Loader env, naming the type its prototype gives
// it, and stores and queues each as a plain object. celld classified host
// values by prototype, so an object claiming Date's or Headers' prototype
// crossed unescaped and revived as a marker (plan 1.53). Each step reports
// "plain" for an object that arrived as a plain object with its keys, or
// the error or shape instead. Proxies are rpc/marker-shaped-proxies.
import { DurableObject, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { OBJECT_NAMES, object, plainVerdict } from "#marker-shaped";

const each = async (fn) => {
  const out = {};
  for (const name of OBJECT_NAMES) {
    try {
      out[name] = await fn(name);
    } catch (error) {
      out[name] = `${error.name}: ${error.message}`;
    }
  }
  return out;
};

// A receiver's params (alone and beside a Headers) and results.
const rpc = async (receiver) => ({
  params: await each((name) => receiver.probe({ v: object(name, RpcTarget) })),
  paramsLift: await each((name) => receiver.probe({ lift: new Headers(), v: object(name, RpcTarget) })),
  result: await each(async (name) => plainVerdict((await receiver.give(name)).v)),
});

export class Echo extends WorkerEntrypoint {
  probe(arg) {
    return plainVerdict(arg.v);
  }
  give(name) {
    return { lift: new Headers(), v: object(name, RpcTarget) };
  }
}

export class Obj extends DurableObject {
  probe(arg) {
    return plainVerdict(arg.v);
  }
  give(name) {
    return { lift: new Headers(), v: object(name, RpcTarget) };
  }
  async storage() {
    const { storage } = this.ctx;
    return each(async (name) => {
      await storage.put(name, { v: object(name, RpcTarget) });
      storage.kv.put(`kv-${name}`, { v: object(name, RpcTarget) });
      return {
        get: plainVerdict((await storage.get(name)).v),
        many: plainVerdict((await storage.get([name])).get(name).v),
        kv: plainVerdict(storage.kv.get(`kv-${name}`).v),
      };
    });
  }
  record(name, verdict) {
    this.ctx.storage.kv.put(name, verdict);
  }
  recorded() {
    const out = {};
    for (const name of OBJECT_NAMES) {
      const verdict = this.ctx.storage.kv.get(name);
      if (verdict === undefined) return null;
      out[name] = verdict;
    }
    return out;
  }
}

const LOADED =
  "export default { fetch(request, env) {" +
  " const v = env.v; const plain = Object.getPrototypeOf(v) === Object.prototype;" +
  " return Response.json({ plain, keys: Object.keys(v).length }); } };";

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname === "/rpc") return Response.json(await rpc(ctx.exports.Echo));
    if (pathname === "/do") return Response.json(await rpc(env.OBJ.getByName("do")));
    if (pathname === "/service")
      return Response.json(await each((name) => env.OTHER.probe({ v: object(name, RpcTarget) })));
    if (pathname === "/loader")
      return Response.json(await each(async (name) => {
        const worker = env.LOADER.load({
          compatibilityDate: "2026-01-01",
          mainModule: "main.js",
          modules: { "main.js": LOADED },
          env: { v: object(name, RpcTarget) },
        });
        return (await worker.getEntrypoint().fetch("http://loaded/")).json();
      }));
    if (pathname === "/storage") return Response.json(await env.OBJ.getByName("storage").storage());
    for (const name of OBJECT_NAMES)
      await env.QUEUE.send({ name, v: object(name, RpcTarget) }, { contentType: "v8" });
    const queue = env.OBJ.getByName("queue");
    for (let attempt = 0; attempt < 200; attempt++) {
      const recorded = await queue.recorded();
      if (recorded !== null) return Response.json(recorded);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return new Response("the messages did not arrive", { status: 500 });
  },
  async queue(batch, env) {
    for (const message of batch.messages) {
      await env.OBJ.getByName("queue").record(message.body.name, plainVerdict(message.body.v));
      message.ack();
    }
  },
};
