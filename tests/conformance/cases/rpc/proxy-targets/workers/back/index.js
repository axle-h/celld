// Entrypoints whose constructors return a Proxy, called by `front` through
// service bindings.
import { DurableObject, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";

// IlyaGulya's cloudflare-os-compat `ProxyEntrypoint`.
export class ProxyEntrypoint extends WorkerEntrypoint {
  constructor(ctx, env) {
    super(ctx, env);
    return new Proxy(
      {},
      {
        getPrototypeOf: () => WorkerEntrypoint.prototype,
        get: (_target, prop) => {
          if (prop === "then") return undefined;
          if (prop === "runAt") return (value) => `proxy-entrypoint:${value}`;
          return undefined;
        },
      },
    );
  }

  dummyMethod() {}
}

// A get-only Proxy as `front`'s `getOnly()` builds it, as an entrypoint
// instance. `greet` returns the traps its own lookup ran on `greet` (workerd
// also reads each handler name as it constructs the entrypoint). It also
// answers the reserved names, which must never reach it.
export class Probe extends WorkerEntrypoint {
  constructor(ctx, env) {
    super(ctx, env);
    const traps = {};
    const count = (trap, prop) => {
      if (typeof prop === "string") traps[`${trap} ${prop}`] = (traps[`${trap} ${prop}`] ?? 0) + 1;
    };
    const answers = {
      greet: (name) => ({
        greeting: `entrypoint:${name}`,
        traps: Object.fromEntries(Object.entries(traps).filter(([key]) => key.endsWith(" greet"))),
      }),
      claimed: () => "claimed",
      version: 7,
      alarm: () => "alarm reached the Proxy",
      webSocketMessage: () => "webSocketMessage reached the Proxy",
      dup: () => "dup reached the Proxy",
      nested: new Proxy(
        {},
        {
          getPrototypeOf: () => RpcTarget.prototype,
          get: (_target, prop) => (prop === "greet" ? (name) => `nested:${name}` : undefined),
        },
      ),
    };
    return new Proxy(
      { own: () => "own" },
      {
        getPrototypeOf: () => WorkerEntrypoint.prototype,
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
  }

  prototypeMethod() {
    return "prototype";
  }
}

export class Session extends DurableObject {
  greet(name) {
    return `session:${name}`;
  }
}

// Cloudflare OS's GatekeeperLoopback: the constructor returns a Proxy that
// forwards every method to a Durable Object stub.
export class Loopback extends WorkerEntrypoint {
  constructor(ctx, env) {
    super(ctx, env);
    const session = env.SESSION.getByName("gatekeeper");
    return new Proxy(
      {},
      {
        get: (_target, prop) => (prop === "then" || typeof prop !== "string" ? undefined : session[prop]),
      },
    );
  }
}

export default {
  fetch() {
    return new Response("back");
  },
};
