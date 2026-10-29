// Refusals only, for names no workerd client sends.
//
// celld's service bindings and ctx.exports stubs always have workerd's
// test hook, getRpcMethodForTestOnly(name), which sends any name. A stub
// answers Object.prototype's names locally, so only the hook (or a peer)
// can send them, and the receiver refuses them before any user code runs.
//
// A KV, Queue or D1 binding calls a runtime cell through a Durable Object
// stub, which user code once reached as the binding's `_stub`. Now the
// binding keeps its cell private.
import { WorkerEntrypoint } from "cloudflare:workers";

const reached = () => "REACHED";

// The error a refused call rejects with, or what it answered instead.
async function refused(fn) {
  try {
    return { answered: await fn() };
  } catch (error) {
    return `${error.name}: ${error.message}`;
  }
}

export class Local extends WorkerEntrypoint {
  toString() {
    return reached();
  }

  hasOwnProperty() {
    return reached();
  }
}

// The properties a binding's stub, namespace or cell name was once read
// through.
const STUB_ROUTES = ["_stub", "_namespace", "_cellName", "_queue", "_databaseName", "_database"];

const NAMES = [
  "constructor", "fetch", "connect", "toString", "valueOf", "hasOwnProperty",
  "isPrototypeOf", "__proto__", "__defineGetter__", "__lookupGetter__",
];

async function hook(stub) {
  const out = [];
  for (const name of NAMES) out.push([name, await refused(() => stub.getRpcMethodForTestOnly(name)(1))]);
  return Object.fromEntries(out);
}

export default {
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    if (path === "/hook") {
      return Response.json({
        local: await hook(ctx.exports.Local),
        entry: await hook(env.ENTRY),
        object: await hook(env.OBJECT),
        // A property read of a reserved name.
        localGet: await refused(() => ctx.exports.Local.getRpcMethodForTestOnly("constructor")),
      });
    }
    if (path === "/runtime") {
      // The stubs were once a binding's `_stub`; now nothing a binding holds
      // names its cell. The cells' own method refusals are unit tests
      // (`js::runtime_cell_tests`), since no script reaches a stub to call.
      const reach = (binding) => STUB_ROUTES.filter((name) => name in binding);
      return Response.json({
        kv: reach(env.KV),
        queue: reach(env.QUEUE),
        db: reach(env.DB),
        session: reach(env.DB.withSession()),
        statement: reach(env.DB.prepare("SELECT 1")),
      });
    }
    return new Response("not found", { status: 404 });
  },
};
