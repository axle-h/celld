// workerd's Fetcher has getRpcMethodForTestOnly() only under the
// experimental flag (api/http.h), so without it the name is an RPC method
// like any other: a call reaches the target's method of that name, and a
// target without one refuses it as a missing method.
import { WorkerEntrypoint } from "cloudflare:workers";

export class Local extends WorkerEntrypoint {
  getRpcMethodForTestOnly(name) {
    return `Local: ${name}`;
  }
}

export class Bare extends WorkerEntrypoint {
  hello() {
    return "hello";
  }
}

const outcome = async (fn) => {
  try {
    return { answered: await fn() };
  } catch (error) {
    return `${error.name}: ${error.message}`;
  }
};

export default {
  async fetch(request, env, ctx) {
    return Response.json({
      object: await outcome(() => env.OBJECT.getRpcMethodForTestOnly("constructor")),
      entry: await outcome(() => env.ENTRY.getRpcMethodForTestOnly("constructor")),
      local: await outcome(() => ctx.exports.Local.getRpcMethodForTestOnly("toString")),
      bare: await outcome(() => ctx.exports.Bare.getRpcMethodForTestOnly("hello")),
      own: Object.getOwnPropertyNames(Object.getPrototypeOf(env.OBJECT)).includes("getRpcMethodForTestOnly"),
    });
  },
};
