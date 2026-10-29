// A namespace, its ids and stubs, and the KV and Queue bindings keep their
// state private, and none can be constructed: their own properties are
// workerd's, and `new value.constructor()` throws "Illegal constructor".
// celld's once held a namespace's class and key, and a binding's cell stub,
// where a script could read them or build its own (plan 1.49).
import { DurableObject } from "cloudflare:workers";

function shape(value) {
  let construct;
  try {
    new value.constructor("Obj", "key");
    construct = "constructed";
  } catch (error) {
    construct = `${error.name}: ${error.message}`;
  }
  return { own: Reflect.ownKeys(value).map(String), construct };
}

export class Obj extends DurableObject {
  ping() {
    return "pong";
  }
}

export default {
  async fetch(request, env) {
    const id = env.OBJ.idFromName("x");
    const stub = env.OBJ.get(id);
    return Response.json({
      namespace: shape(env.OBJ),
      id: shape(id),
      stub: Reflect.ownKeys(stub).map(String),
      kv: shape(env.KV),
      queue: shape(env.QUEUE),
      // The bindings still work.
      ping: await stub.ping(),
      equals: id.equals(env.OBJ.idFromString(id.toString())),
      kvPut: await env.KV.put("k", "v").then(() => env.KV.get("k")),
      queueSend: await env.QUEUE.send("m").then(() => "sent"),
    });
  },
};
