// Method lookup on a Durable Object, through its stub. workerd treats the
// object as an entrypoint (worker-rpc.c++ EntrypointJsRpcTarget): its
// handler names are reserved at every step of a path, only class members are
// visible, a member that reads undefined is a missing method, and awaiting a
// member reads it. The stub's own members (`fetch`, `connect`, `id`, `name`
// and Object.prototype's) are answered locally and never sent.
import { DurableObject, RpcProperty } from "cloudflare:workers";

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
  constructor(ctx, env) {
    super(ctx, env);
    this.ownMethod = () => "own method reached";
  }

  greet(name) {
    return `host:${name}`;
  }

  get version() {
    return 7;
  }

  // A prototype accessor that reads undefined is a missing method.
  get nothing() {
    return undefined;
  }

  // A plain object a path continues through. Its own functions are called
  // with it as `this`, and the object's reserved names are the Durable
  // Object's.
  get tools() {
    return {
      label: "tools",
      undef: undefined,
      add(a, b) {
        return `${this.label}:${a + b}`;
      },
      nested: { deep: 1 },
      list: [1, 2],
      alarm: () => "tools alarm reached",
      fetch: () => "tools fetch reached",
      connect: () => "tools connect reached",
      dup: () => "tools dup reached",
    };
  }

  // Lifecycle handlers and reserved names, which RPC never reaches.
  alarm() {
    return "alarm reached";
  }

  webSocketMessage() {
    return "webSocketMessage reached";
  }

  webSocketClose() {
    return "webSocketClose reached";
  }

  webSocketError() {
    return "webSocketError reached";
  }

  dup() {
    return "dup reached";
  }

  // Ordinary methods on a Durable Object.
  queue() {
    return "queue reached";
  }

  scheduled() {
    return "scheduled reached";
  }

  toString() {
    return "toString reached";
  }
}

async function lookup(host) {
  return {
    greet: await attempt(() => host.greet("a")),
    own: await attempt(() => host.ownMethod()),
    ctx: await attempt(() => host.ctx),
    env: await attempt(() => host.env),
    missing: await attempt(() => host.missing()),
    missingGet: await attempt(() => host.missing),
    version: await attempt(() => host.version),
    versionCall: await attempt(() => host.version()),
    nothing: await attempt(() => host.nothing),
    nothingCall: await attempt(() => host.nothing()),
    alarm: await attempt(() => host.alarm()),
    webSocketMessage: await attempt(() => host.webSocketMessage()),
    webSocketClose: await attempt(() => host.webSocketClose()),
    webSocketError: await attempt(() => host.webSocketError()),
    dup: await attempt(() => host.dup()),
    queue: await attempt(() => host.queue()),
    scheduled: await attempt(() => host.scheduled()),
    // Answered by the stub, not by the object's own toString().
    toString: await attempt(() => host.toString() === "toString reached"),
  };
}

async function paths(host) {
  return {
    label: await attempt(() => host.tools.label),
    undef: await attempt(() => host.tools.undef),
    missing: await attempt(() => host.tools.missing),
    add: await attempt(() => host.tools.add(1, 2)),
    deep: await attempt(() => host.tools.nested.deep),
    deepMissing: await attempt(() => host.tools.nested.missing),
    labelCall: await attempt(() => host.tools.label()),
    // An array has no members to walk into.
    listLength: await attempt(() => host.tools.list.length),
    // A primitive has none either.
    labelLength: await attempt(() => host.tools.label.length),
    // The Durable Object's reserved names hold at every step.
    alarm: await attempt(() => host.tools.alarm()),
    fetch: await attempt(() => host.tools.fetch()),
    connect: await attempt(() => host.tools.connect()),
    dup: await attempt(() => host.tools.dup()),
    // A name that cannot be a member stops the path first.
    missingThenAlarm: await attempt(() => host.missing.alarm()),
    // A pipelined call through a call's result.
    viaCall: await attempt(() => host.greet("x").length),
  };
}

// What the stub answers itself.
function stub(host, other) {
  const kind = (name) => {
    const value = host[name];
    if (value === undefined) return "undefined";
    if (value instanceof RpcProperty) return "RpcProperty";
    if (value === Object.prototype[name]) return "Object.prototype";
    return typeof value;
  };
  const names = [
    "toString", "valueOf", "hasOwnProperty", "isPrototypeOf", "propertyIsEnumerable",
    "toLocaleString", "__defineGetter__", "__lookupGetter__", "constructor", "then",
    "fetch", "connect", "id", "name", "dup", "greet", "call", "bind", "0",
  ];
  return {
    kinds: Object.fromEntries(names.map((name) => [name, kind(name)])),
    in: Object.fromEntries(["toString", "then", "greet", "dup", "fetch", "0"].map((name) => [name, name in host])),
    constructorIsProperty: host.constructor instanceof RpcProperty,
    tag: Object.prototype.toString.call(host),
    // One connect() serves every stub, as Fetcher.prototype.connect does.
    sameConnect: host.connect === other.connect,
  };
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    const host = env.HOST.getByName("lookup");
    if (path === "/lookup") return Response.json(await lookup(host));
    if (path === "/paths") return Response.json(await paths(host));
    if (path === "/stub") return Response.json(stub(host, env.HOST.getByName("other")));
    return new Response("not found", { status: 404 });
  },
};
