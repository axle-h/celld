// Plain data shaped like celld's markers, in a facet call's params beside a
// value that needs celld's lift, crosses as the plain data it is (plan
// 1.53). celld refuses a capability or host value in a facet's params until
// plan 3.1 (`__rpcOut(args, false)`); rpc/marker-shaped-data covers the
// facet's plain params and its results.
import { DurableObject, RpcTarget } from "cloudflare:workers";
import { compare, forged } from "#marker-shaped";

class Target extends RpcTarget {}

const LIFTS = {
  headers: () => new Headers(),
  request: () => new Request("https://example.com/"),
  target: () => new Target(),
  function: () => () => "called",
};

export class Child extends DurableObject {
  probe(arg) {
    return compare(arg.forged);
  }
}

export class Obj extends DurableObject {
  async fetch() {
    const child = this.ctx.facets.get("child", () => ({ class: this.ctx.exports.Child }));
    const out = {};
    for (const [name, lift] of Object.entries(LIFTS)) {
      try {
        out[name] = await child.probe({ lift: lift(), forged: forged() });
      } catch (error) {
        out[name] = { error: `${error.name}: ${error.message}` };
      }
    }
    return Response.json(out);
  }
}

export default {
  fetch(request, env) {
    return env.OBJ.getByName("facet").fetch(request);
  },
};
