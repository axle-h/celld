// Receiver rules for a path pipelined through a call's result, which
// workerd applies at the far end (worker-rpc.c++
// serializeJsValueWithPipeline and tryGetProperty). A plain object exposes
// its own properties, one of which may be undefined; a name it does not have
// is a missing method, not `undefined`. A stub, an RpcTarget or a function
// hands the path to its target. Any other result -- a primitive, an array,
// a class instance, or a Proxy that claims to be an RpcTarget -- has no
// pipeline, so its first name is a missing method. A path through a result
// reserves `dup` and `constructor`, as any transient target does.
import { DurableObject, RpcStub, RpcTarget } from "cloudflare:workers";

// `undefined` does not survive JSON, so say what the value is as well.
async function attempt(fn) {
  try {
    const value = await fn();
    return { type: typeof value, value: value ?? null };
  } catch (error) {
    return { error: `${error.name}: ${error.message}` };
  }
}

export class Host extends DurableObject {
  getObj() {
    return { field: "value", undef: undefined, inner: { deep: 1 }, list: [1, 2] };
  }

  getNumber() {
    return 42;
  }

  getString() {
    return "text";
  }

  getArray() {
    return [{ a: 1 }, 2];
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

  getNull() {
    return null;
  }

  getUndefined() {
    return undefined;
  }
}

class Target extends RpcTarget {
  greet(name) {
    return `target:${name}`;
  }

  get nothing() {
    return undefined;
  }

  dup() {
    return "target dup reached";
  }
}

// A get-only Proxy that claims to be an RpcTarget.
const proxyTarget = () =>
  new Proxy(
    {},
    {
      getPrototypeOf: () => RpcTarget.prototype,
      get: (_target, prop) => (prop === "greet" ? (name) => `proxy:${name}` : undefined),
    },
  );

// Results that carry stubs, from a target in this isolate.
class Maker extends RpcTarget {
  getObj() {
    return {
      label: "obj",
      run(arg) {
        return `run:${arg}`;
      },
      fetch: () => "result fetch reached",
      alarm: () => "result alarm reached",
      dup: () => "result dup reached",
      nested: { list: [1, 2], target: new Target() },
    };
  }

  getTarget() {
    return new Target();
  }

  getProxyTarget() {
    return proxyTarget();
  }

  getStubbedProxy() {
    return new RpcStub(proxyTarget());
  }

  getFunction() {
    const fn = (arg) => `fn:${arg}`;
    fn.prop = 3;
    return fn;
  }
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    const host = env.HOST.getByName("rules");
    if (path === "/") {
      return Response.json({
        missing: await attempt(() => host.getObj().missing),
        missingDeep: await attempt(() => host.getObj().missing.deeper),
        primitive: await attempt(() => host.getNumber().toFixed),
      });
    }
    if (path === "/kinds") {
      return Response.json({
        field: await attempt(() => host.getObj().field),
        undef: await attempt(() => host.getObj().undef),
        deep: await attempt(() => host.getObj().inner.deep),
        deepMissing: await attempt(() => host.getObj().inner.missing),
        fieldCall: await attempt(() => host.getObj().field()),
        list: await attempt(() => host.getObj().list),
        listLength: await attempt(() => host.getObj().list.length),
        listIndex: await attempt(() => host.getObj().list[0]),
        string: await attempt(() => host.getString().length),
        array: await attempt(() => host.getArray().length),
        arrayIndex: await attempt(() => host.getArray()[0]),
        date: await attempt(() => host.getDate().getTime()),
        map: await attempt(() => host.getMap().size),
        bytes: await attempt(() => host.getBytes().length),
        error: await attempt(() => host.getError().message),
        response: await attempt(() => host.getResponse().status),
        null: await attempt(() => host.getNull().x),
        undefined: await attempt(() => host.getUndefined().x),
      });
    }
    if (path === "/stubs") {
      using maker = new RpcStub(new Maker());
      return Response.json({
        run: await attempt(() => maker.getObj().run("a")),
        label: await attempt(() => maker.getObj().label),
        // A result's reserved names are a transient target's.
        fetch: await attempt(() => maker.getObj().fetch()),
        alarm: await attempt(() => maker.getObj().alarm()),
        dup: await attempt(() => maker.getObj().dup()),
        nestedList: await attempt(() => maker.getObj().nested.list.length),
        nestedTarget: await attempt(() => maker.getObj().nested.target.greet("n")),
        nestedTargetDup: await attempt(() => maker.getObj().nested.target.dup()),
        target: await attempt(() => maker.getTarget().greet("t")),
        targetNothing: await attempt(() => maker.getTarget().nothing),
        targetDup: await attempt(() => maker.getTarget().dup()),
        // A returned Proxy is a stub once it arrives, but its call has no
        // pipeline. An RpcStub around it does.
        proxy: await attempt(() => maker.getProxyTarget().greet("p")),
        proxyAwaited: await attempt(async () => (await maker.getProxyTarget()).greet("p")),
        stubbedProxy: await attempt(() => maker.getStubbedProxy().greet("s")),
        fn: await attempt(() => maker.getFunction()("f")),
        fnProp: await attempt(() => maker.getFunction().prop),
        fnName: await attempt(() => maker.getFunction().name),
        fnMissing: await attempt(() => maker.getFunction().missing),
      });
    }
    return new Response("not found", { status: 404 });
  },
};
