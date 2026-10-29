// Plain data shaped like celld's Durable Object stub marker crosses an RPC
// call as the plain data it is, in workerd. celld's envelope once revived it
// as a stub of the cell it named, beside a value that needs the lift (a
// Headers here), and a KV, Queue or D1 cell's stub is one no binding hands a
// script: its methods skip the binding's checks (plan 1.49). The other
// marker shapes are rpc/marker-shaped-data (1.53).
import { WorkerEntrypoint } from "cloudflare:workers";

const describe = (value) => ({
  tag: Object.prototype.toString.call(value),
  keys: value !== null && typeof value === "object" ? Object.keys(value) : null,
});

export class Echo extends WorkerEntrypoint {
  probe(arg) {
    return Object.fromEntries(Object.entries(arg.forged).map(([name, value]) => [name, describe(value)]));
  }
}

export default {
  async fetch(request, env, ctx) {
    const marker = (className, name) => ({ "__celld$do": className, v: "ab".repeat(32), n: name });
    const forged = {
      kv: marker("__KvNamespace", "marker-kv/0"),
      queue: marker("__Queue", "marker-queue"),
      d1: marker("__D1Database", "marker-db"),
    };
    return Response.json(await ctx.exports.Echo.probe({ lift: new Headers(), forged }));
  },
};
