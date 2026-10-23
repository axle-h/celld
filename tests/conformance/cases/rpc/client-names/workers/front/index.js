// The names a client answers locally, as workerd does: its prototype
// chain's (RpcStub.prototype, RpcPromise.prototype, RpcProperty.prototype or
// a Fetcher's, then Object.prototype), `then` where it is not a promise, and
// array indices, which workerd's wildcard property never sees. Every other
// string is a remote member, an RpcProperty, and is `in` the object. The
// targets define the Object.prototype names too, and record any that reach
// them.
import { RpcPromise, RpcProperty, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";

const reached = [];

class Target extends RpcTarget {
  greet(name) {
    return `target:${name}`;
  }

  toString() {
    reached.push("toString");
    return "target toString reached";
  }

  valueOf() {
    reached.push("valueOf");
    return "target valueOf reached";
  }

  hasOwnProperty() {
    reached.push("hasOwnProperty");
    return true;
  }

  isPrototypeOf() {
    reached.push("isPrototypeOf");
    return true;
  }
}

export class Local extends WorkerEntrypoint {
  toString() {
    return "local toString reached";
  }

  greet(name) {
    return `local:${name}`;
  }
}

const NAMES = [
  "toString", "valueOf", "hasOwnProperty", "isPrototypeOf", "propertyIsEnumerable",
  "toLocaleString", "__defineGetter__", "__defineSetter__", "__lookupGetter__",
  "__lookupSetter__", "constructor", "then", "catch", "finally", "dup", "fetch",
  "greet", "call", "apply", "bind", "name", "length", "prototype", "0", "42",
];

const CLASSES = { RpcStub, RpcPromise, RpcProperty };

// What reading `name` gives, without calling anything remote.
function kind(object, name) {
  const value = object[name];
  if (value === undefined) return "undefined";
  if (value instanceof RpcProperty) return "RpcProperty";
  if (value === Object.prototype[name]) return "Object.prototype";
  const named = Object.entries(CLASSES).find(([, cls]) => cls === value);
  if (named) return named[0];
  return typeof value;
}

function describe(object) {
  return {
    kinds: Object.fromEntries(NAMES.map((name) => [name, kind(object, name)])),
    in: Object.fromEntries(NAMES.map((name) => [name, name in object])),
    // Object.prototype's toString(), found locally, names the client.
    toString: object.toString(),
    tag: Object.prototype.toString.call(object),
    template: `${object}`,
    valueOfSelf: object.valueOf() === object,
    hasOwn: object.hasOwnProperty("greet"),
  };
}

export default {
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    if (path === "/stub") {
      using stub = new RpcStub(new Target());
      const described = describe(stub);
      return Response.json({ ...described, greet: await stub.greet("a"), reached });
    }
    if (path === "/promise") {
      using stub = new RpcStub(new Target());
      const promise = stub.greet("a");
      const described = describe(promise);
      return Response.json({ ...described, awaited: await promise, reached });
    }
    if (path === "/property") {
      using stub = new RpcStub(new Target());
      const described = describe(stub.greet);
      return Response.json({ ...described, called: await stub.greet("b"), reached });
    }
    if (path === "/exports") {
      const stub = ctx.exports.Local;
      return Response.json({
        kinds: Object.fromEntries(NAMES.map((name) => [name, kind(stub, name)])),
        valueOfSelf: stub.valueOf() === stub,
        hasOwn: stub.hasOwnProperty("greet"),
        greet: await stub.greet("c"),
      });
    }
    if (path === "/service") {
      const stub = env.BACK;
      return Response.json({
        kinds: Object.fromEntries(NAMES.map((name) => [name, kind(stub, name)])),
        valueOfSelf: stub.valueOf() === stub,
        hasOwn: stub.hasOwnProperty("greet"),
      });
    }
    return new Response("not found", { status: 404 });
  },
};
