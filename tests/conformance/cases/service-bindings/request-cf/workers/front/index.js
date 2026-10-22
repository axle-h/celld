// A request's `cf` reaches the target of a Fetcher, directly and on each hop
// of a followed redirect, through every kind of Fetcher. celld delivers it
// only to a target in the caller's isolate (plan 1.41).
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

const serve = (request) => {
  const url = new URL(request.url);
  if (url.pathname === "/redirect")
    return new Response(null, { status: 307, headers: { location: "/cf" } });
  return Response.json(request.cf ?? null);
};

const CODE = `const serve = ${serve.toString()}; export default { fetch: serve };`;

export class Obj extends DurableObject {
  fetch(request) {
    return serve(request);
  }
}

export class Local extends WorkerEntrypoint {
  fetch(request) {
    return serve(request);
  }
}

export default {
  async fetch(request, env, ctx) {
    const targets = {
      back: env.BACK,
      loopback: ctx.exports.Local,
      object: env.OBJ.getByName("a"),
      loader: env.LOADER.get("request-cf-v1", () => ({
        compatibilityDate: "2026-01-01",
        mainModule: "app.js",
        modules: { "app.js": CODE },
      })).getEntrypoint(),
    };
    const cf = { colo: "TEST", custom: { nested: [1, 2] } };
    const seen = {};
    for (const [name, target] of Object.entries(targets)) {
      seen[name] = {
        direct: await (await target.fetch("http://target.test/cf", { cf })).json(),
        redirected: await (await target.fetch("http://target.test/redirect", { cf })).json(),
      };
    }
    return Response.json(seen);
  },
};
