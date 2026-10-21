// The cloudflare:workers exports celld doesn't implement yet, and
// ctx.restore(). Each fails on first use with an error that names it;
// importing, holding, logging and serializing them does not.
import { inspect } from "node:util";
import * as cf from "cloudflare:workers";
import {
  DurableObject,
  abortIsolate,
  cache,
  tracing,
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
          read: attempt(() => tracing.enterSpan),
          readCache: attempt(() => cache.purge),
          write: attempt(() => { tracing.x = 1; }),
          has: attempt(() => "enterSpan" in tracing),
          delete: attempt(() => delete cache.purge),
        },
        inert: {
          names: [abortIsolate, withEnv, withExports, withEnvAndExports].map((f) => f.name),
          types: [typeof tracing, typeof cache],
          then: typeof tracing.then,
          awaited: (await tracing) === tracing,
          keys: Object.keys(cache),
          has: ["then" in tracing, "toString" in tracing],
        },
        logging: {
          console: attempt(() => console.log(tracing, cache)),
          consoleNamespace: attempt(() => console.log(cf)),
          json: [JSON.stringify(tracing), JSON.stringify({ cache })],
          string: String(cache),
          inspect: inspect(tracing),
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
