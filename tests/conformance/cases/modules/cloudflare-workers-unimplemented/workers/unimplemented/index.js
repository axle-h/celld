// The cloudflare:workers exports celld doesn't implement yet, and
// ctx.restore(). Each fails on first use with an error that names it;
// importing, holding, logging and serializing them does not.
import { inspect } from "node:util";
import * as cf from "cloudflare:workers";
import {
  DurableObject,
  abortIsolate,
  cache,
  withEnv,
  withEnvAndExports,
  withExports,
} from "cloudflare:workers";

function attempt(use) {
  try {
    use();
    return "ok";
  } catch (error) {
    return `${error.name}: ${error.message}`;
  }
}

async function restoreOutcome(ctx) {
  try {
    await ctx.restore({});
    return "ok";
  } catch (error) {
    return `${error.name}: ${error.message}`;
  }
}

export class Probe extends DurableObject {
  restore() {
    return restoreOutcome(this.ctx);
  }
}

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname === "/exports") {
      return Response.json({
        calls: {
          abortIsolate: attempt(() => abortIsolate("x")),
          withEnv: attempt(() => withEnv({}, () => {})),
          withExports: attempt(() => withExports({}, () => {})),
          withEnvAndExports: attempt(() => withEnvAndExports({}, {}, () => {})),
          construct: attempt(() => new withEnv()),
          subclass: attempt(() => new (class extends withEnv {})()),
        },
        objects: {
          read: attempt(() => cache.purge),
          write: attempt(() => { cache.x = 1; }),
          has: attempt(() => "purge" in cache),
          delete: attempt(() => delete cache.purge),
        },
        inert: {
          names: [abortIsolate, withEnv, withExports, withEnvAndExports].map((f) => f.name),
          type: typeof cache,
          then: typeof cache.then,
          awaited: (await cache) === cache,
          keys: Object.keys(cache),
          has: ["then" in cache, "toString" in cache],
        },
        logging: {
          console: attempt(() => console.log(cache)),
          consoleNamespace: attempt(() => console.log(cf)),
          json: [JSON.stringify(cache), JSON.stringify({ cache })],
          string: String(cache),
          inspect: inspect(cache),
        },
      });
    }
    if (pathname === "/ctx-restore") {
      return Response.json({
        execution: await restoreOutcome(ctx),
        durableObject: await env.PROBE.getByName("probe").restore(),
      });
    }
    return new Response("not found", { status: 404 });
  },
};
