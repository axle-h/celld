// Values V8 cannot clone, refused by Durable Object storage (put, put of
// several, kv.put), a Queue (send, sendBatch with the v8 content type) and
// structuredClone(), each with V8's text in a DOMException named
// DataCloneError, as workerd throws it.
import { DurableObject } from "cloudflare:workers";

const values = () => ({
  function: () => 1,
  symbol: Symbol("s"),
  proxy: new Proxy({ a: 1 }, {}),
  nested: { list: [() => 2] },
  weakMap: new WeakMap(),
});

async function refusal(fn) {
  try {
    await fn();
    return "accepted";
  } catch (error) {
    return `${error instanceof DOMException ? "DOMException" : "not DOMException"} ${error.name}: ${error.message}`;
  }
}

export class Obj extends DurableObject {
  async run() {
    const { storage } = this.ctx;
    const out = {};
    for (const [name, value] of Object.entries(values())) {
      out[name] = {
        put: await refusal(() => storage.put(name, value)),
        putMany: await refusal(() => storage.put({ [name]: value })),
        kvPut: await refusal(() => storage.kv.put(name, value)),
      };
    }
    return out;
  }
}

export default {
  async fetch(request, env) {
    const out = await env.OBJ.getByName("a").run();
    for (const [name, value] of Object.entries(values())) {
      out[name].send = await refusal(() => env.QUEUE.send(value, { contentType: "v8" }));
      out[name].sendBatch = await refusal(() => env.QUEUE.sendBatch([{ body: value, contentType: "v8" }]));
      out[name].structuredClone = await refusal(() => structuredClone(value));
    }
    return Response.json(out);
  },
};
