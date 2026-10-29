// A Proxy over an RPC stub, passed as a param and called: workerd throws
// Illegal invocation, as a stub's methods need the stub itself. celld stubs
// the Proxy and its call reaches the target (plan 1.58).
import { RpcStub, RpcTarget } from "cloudflare:workers";

async function attempt(fn) {
  try {
    return await fn();
  } catch (error) {
    return `${error.name}: ${error.message}`;
  }
}

class Named extends RpcTarget {
  hi() {
    return "hi";
  }
}

class Sink extends RpcTarget {
  take(stub) {
    return stub.hi();
  }
}

export default {
  async fetch() {
    const proxied = new Proxy(new RpcStub(new Named()), {});
    return Response.json({
      direct: await attempt(() => proxied.hi()),
      param: await attempt(() => new RpcStub(new Sink()).take(proxied)),
    });
  },
};
