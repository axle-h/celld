// RPC method lookup on Proxies, in one isolate: a get-only Proxy wrapped in
// `new RpcStub()`, one returned from an RpcTarget method, one forwarding to a
// Durable Object stub, and `ctx.exports` and service-binding calls to
// entrypoints whose constructors return a Proxy (`back`).
//
// workerd looks a method up with [[Get]] alone (worker-rpc.c++
// tryGetProperty): a Proxy's `get` trap answers, its `has` trap is never
// asked, own properties stay hidden from RpcTargets and entrypoints, and a
// lookup that reads `undefined` is a missing method.
import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";

// `undefined` does not survive JSON, so say what the value is as well.
async function attempt(fn) {
  try {
    const value = await fn();
    return { type: typeof value, value: value ?? null };
  } catch (error) {
    return { error: `${error.name}: ${error.message}` };
  }
}

// A Proxy that reports `proto` as its prototype and answers from its `get`
// trap alone, the shape Cloudflare OS gives a facet stub. Its `has` trap
// claims only `ghost`, which `get` does not answer, and its
// `getOwnPropertyDescriptor` trap claims `claimed` as an own property.
// `traps` counts each trap per key, so a probe can say which traps a lookup
// ran.
function getOnly(proto, extra = {}) {
  const traps = {};
  const count = (trap, prop) => {
    if (typeof prop === "string") traps[`${trap} ${prop}`] = (traps[`${trap} ${prop}`] ?? 0) + 1;
  };
  const answers = {
    greet: (name) => `proxy:${name}`,
    claimed: () => "claimed",
    version: 7,
    ...extra,
  };
  const proxy = new Proxy(
    { own: () => "own" },
    {
      getPrototypeOf: () => proto,
      get(target, prop) {
        count("get", prop);
        if (Object.hasOwn(answers, prop)) return answers[prop];
        if (prop === "own") return target.own;
        return undefined;
      },
      has(_target, prop) {
        count("has", prop);
        return prop === "ghost";
      },
      getOwnPropertyDescriptor(target, prop) {
        count("own", prop);
        if (prop === "claimed") {
          return { value: answers.claimed, writable: true, enumerable: true, configurable: true };
        }
        return Reflect.getOwnPropertyDescriptor(target, prop);
      },
    },
  );
  return { proxy, traps };
}

// Each lookup rule, on a stub over a get-only Proxy that reports RpcTarget's
// prototype.
async function rpcTarget() {
  const nested = getOnly(RpcTarget.prototype).proxy;
  const plain = getOnly(Object.prototype).proxy;
  const { proxy, traps } = getOnly(RpcTarget.prototype, { nested, plain });
  using stub = new RpcStub(proxy);
  const greet = await attempt(() => stub.greet("hello"));
  // A lookup runs `getOwnPropertyDescriptor` and `get` once each, and never
  // `has`.
  const greetTraps = { ...traps };
  return {
    greet,
    greetTraps,
    value: await attempt(() => stub.version),
    callValue: await attempt(() => stub.version()),
    missing: await attempt(() => stub.missing()),
    missingGet: await attempt(() => stub.missing),
    // `has` says yes, `get` answers undefined: missing.
    ghost: await attempt(() => stub.ghost()),
    ghostGet: await attempt(() => stub.ghost),
    // Own properties of the Proxy's target, or ones the Proxy reports as its
    // own, are hidden as an RpcTarget's own properties are.
    own: await attempt(() => stub.own()),
    claimed: await attempt(() => stub.claimed()),
    // A pipelined path through a Proxy RpcTarget, and through a Proxy that
    // reports a plain object's prototype (own properties only).
    nested: await attempt(() => stub.nested.greet("nested")),
    plain: await attempt(() => stub.plain.greet("plain")),
    then: typeof stub.then,
    symbol: typeof stub[Symbol.iterator],
  };
}

// A Proxy over a function wraps as a function: it is callable, and only its
// own properties are visible.
async function functionProxy() {
  const base = (x) => `called:${x}`;
  base.extra = () => "extra";
  const proxy = new Proxy(base, {
    get(target, prop) {
      if (prop === "greet") return () => "greet";
      return Reflect.get(target, prop);
    },
  });
  using stub = new RpcStub(proxy);
  return {
    call: await attempt(() => stub("x")),
    own: await attempt(() => stub.extra()),
    inherited: await attempt(() => stub.greet()),
    name: await attempt(() => stub.name),
  };
}

// A plain object's Proxy wraps as a plain object: own properties only, so a
// `get` trap's answers alone are not visible.
async function plainProxy() {
  const { proxy } = getOnly(Object.prototype);
  using stub = new RpcStub(proxy);
  return {
    greet: await attempt(() => stub.greet("hello")),
    own: await attempt(() => stub.own()),
    claimed: await attempt(() => stub.claimed()),
  };
}

// A get-only Proxy returned from an RpcTarget method crosses as a stub. (Not
// pipelined: workerd builds a returned Proxy's pipeline as a plain object's.)
class Host extends RpcTarget {
  make() {
    return getOnly(RpcTarget.prototype).proxy;
  }
}

async function returned() {
  using host = new RpcStub(new Host());
  using made = await host.make();
  return {
    awaited: await attempt(() => made.greet("awaited")),
    missing: await attempt(() => made.missing()),
  };
}

export class Store extends DurableObject {
  greet(name) {
    return `store:${name}`;
  }
}

// Forward every string key but `then` to `stub`, as Cloudflare OS's facet
// Proxy and GatekeeperLoopback do.
const forwardTo = (stub) =>
  new Proxy(
    {},
    {
      getPrototypeOf: () => RpcTarget.prototype,
      get: (_target, prop) => (prop === "then" || typeof prop !== "string" ? undefined : stub[prop]),
    },
  );

// An entrypoint whose constructor returns a Proxy forwarding to a Durable
// Object stub, called through `ctx.exports`.
export class Loopback extends WorkerEntrypoint {
  constructor(ctx, env) {
    super(ctx, env);
    return forwardTo(env.STORE.getByName("loopback"));
  }
}

async function forward(env, ctx) {
  using stub = new RpcStub(forwardTo(env.STORE.getByName("forward")));
  return {
    target: await attempt(() => stub.greet("target")),
    loopback: await attempt(() => ctx.exports.Loopback.greet("loopback")),
  };
}

// `scheduled` is an ordinary method name over RPC.
export class Scheduled extends WorkerEntrypoint {
  scheduled(arg) {
    return `scheduled:${arg}`;
  }
}

// The entrypoints in `back`, through service bindings.
async function entrypoint(env, ctx) {
  return {
    // With the traps the lookup of `greet` ran, as `greet` saw them.
    greet: await attempt(() => env.PROBE.greet("hello")),
    value: await attempt(() => env.PROBE.version),
    callValue: await attempt(() => env.PROBE.version()),
    missing: await attempt(() => env.PROBE.missing()),
    ghost: await attempt(() => env.PROBE.ghost()),
    own: await attempt(() => env.PROBE.own()),
    claimed: await attempt(() => env.PROBE.claimed()),
    // A prototype method the Proxy does not answer.
    prototype: await attempt(() => env.PROBE.prototypeMethod()),
    // Reserved names are refused before the Proxy is asked.
    alarm: await attempt(() => env.PROBE.alarm()),
    webSocketMessage: await attempt(() => env.PROBE.webSocketMessage()),
    dup: await attempt(() => env.PROBE.dup()),
    // Not reserved. (Through `ctx.exports`: celld's service bindings always
    // have a `scheduled()` of their own.)
    scheduled: await attempt(() => ctx.exports.Scheduled.scheduled("rpc")),
    nested: await attempt(() => env.PROBE.nested.greet("nested")),
    loopback: await attempt(() => env.LOOPBACK.greet("service")),
  };
}

export default {
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    // IlyaGulya's cloudflare-os-compat `/proxy-rpc-target` and
    // `/proxy-entrypoint`.
    if (path === "/proxy-rpc-target") {
      const target = new Proxy(
        {},
        {
          getPrototypeOf() {
            return RpcTarget.prototype;
          },
          get(_target, prop) {
            if (prop === "greet") return (name) => `proxy:${name}`;
            return undefined;
          },
        },
      );
      using stub = new RpcStub(target);
      return Response.json({ result: await stub.greet("hello") });
    }
    if (path === "/proxy-entrypoint") {
      return Response.json({ result: await env.PROXY_EP.runAt("hello") });
    }
    if (path === "/rpc-target") return Response.json(await rpcTarget());
    if (path === "/function") return Response.json(await functionProxy());
    if (path === "/plain") return Response.json(await plainProxy());
    if (path === "/returned") return Response.json(await returned());
    if (path === "/forward") return Response.json(await forward(env, ctx));
    if (path === "/entrypoint") return Response.json(await entrypoint(env, ctx));
    return new Response("not found", { status: 404 });
  },
};
