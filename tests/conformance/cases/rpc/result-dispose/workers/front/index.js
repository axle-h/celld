// workerd gives every object an RPC call or property read answers with its
// own Symbol.dispose (worker-rpc.c++ deserializeRpcReturnValue): a
// non-enumerable, writable, configurable function that disposes the stubs
// the result carries, whether it carries any or not. A stub keeps its own.
import { DurableObject, RpcStub, RpcTarget } from "cloudflare:workers";

// The result's own Symbol.dispose, if it has one.
function disposer(value) {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return "primitive";
  const own = Object.getOwnPropertyDescriptor(value, Symbol.dispose);
  if (!own) return { own: false, type: typeof value[Symbol.dispose] };
  return {
    own: true,
    type: typeof own.value,
    enumerable: own.enumerable,
    writable: own.writable,
    configurable: own.configurable,
    returns: own.value === undefined ? null : typeof own.value.call(value),
  };
}

async function attempt(fn) {
  try {
    return disposer(await fn());
  } catch (error) {
    return { error: `${error.name}: ${error.message}` };
  }
}

export class Host extends DurableObject {
  getObj() {
    return { field: 1, inner: { deep: 1 } };
  }

  getArray() {
    return [1, 2];
  }

  getDate() {
    return new Date(0);
  }

  getMap() {
    return new Map([["k", 1]]);
  }

  getBytes() {
    return new Uint8Array([1, 2]);
  }

  getError() {
    return new Error("returned");
  }

  getResponse() {
    return new Response("body");
  }

  getStub() {
    return this.env.HOST.getByName("other");
  }

  getNumber() {
    return 1;
  }

  get inner() {
    return { deep: 1 };
  }
}

class Target extends RpcTarget {
  getObj() {
    return { field: 1, fn: () => "fn" };
  }

  getTarget() {
    return new Target();
  }

  get props() {
    return { a: 1 };
  }
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === "/durable-object") {
      const host = env.HOST.getByName("dispose");
      return Response.json({
        obj: await attempt(() => host.getObj()),
        keys: Object.keys(await host.getObj()),
        array: await attempt(() => host.getArray()),
        date: await attempt(() => host.getDate()),
        map: await attempt(() => host.getMap()),
        bytes: await attempt(() => host.getBytes()),
        error: await attempt(() => host.getError()),
        response: await attempt(() => host.getResponse()),
        stub: await attempt(() => host.getStub()),
        number: await attempt(() => host.getNumber()),
        // A property read, and a read pipelined through a call's result.
        get: await attempt(() => host.inner),
        pipelined: await attempt(() => host.getObj().inner),
      });
    }
    if (path === "/stub") {
      using target = new RpcStub(new Target());
      return Response.json({
        // A result that carries a stub, and one that is a stub.
        obj: await attempt(() => target.getObj()),
        target: await attempt(() => target.getTarget()),
        get: await attempt(() => target.props),
      });
    }
    return new Response("not found", { status: 404 });
  },
};
