// A service binding passed as an RPC param arrives as a working Fetcher in
// workerd, to an RpcTarget and to a Durable Object. celld refuses it as a
// Proxy that is no RPC receiver type (plan 1.58).
import { DurableObject, RpcStub, RpcTarget } from "cloudflare:workers";

async function attempt(fn) {
  try {
    return await fn();
  } catch (error) {
    return `${error.name}: ${error.message}`;
  }
}

const fetchThrough = async (fetcher) => (await fetcher.fetch("http://self/hello")).text();

class Caller extends RpcTarget {
  use(fetcher) {
    return fetchThrough(fetcher);
  }
}

export class Obj extends DurableObject {
  use(fetcher) {
    return fetchThrough(fetcher);
  }
}

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname === "/hello") return new Response("hello");
    return Response.json({
      target: await attempt(() => new RpcStub(new Caller()).use(env.SELF)),
      durableObject: await attempt(() => env.OBJ.getByName("a").use(env.SELF)),
    });
  },
};
