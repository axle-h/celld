// What a request's `cf` gives the target of a Fetcher, for each way a caller
// sets it, through every kind of Fetcher: none, a Request's, one changed after
// the Request was made, values JSON can't hold, the cache mode's additions,
// and a received request's, forwarded. The target gets a frozen copy, and the
// caller keeps its own, unfrozen.
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

// Whether `cf` and an object in it are frozen, too.
const serve = (request) => {
  const cf = request.cf;
  if (cf === undefined || cf === null) return Response.json(cf === undefined ? "undefined" : null);
  return Response.json({
    cf,
    frozen: Object.isFrozen(cf),
    nestedFrozen: typeof cf.nested === "object" ? Object.isFrozen(cf.nested) : null,
  });
};

// What each way of setting `cf` reaches `fetch`'s target as. Self-contained,
// so a loaded Worker runs it too, through its globalOutbound, and with no
// named inner functions, which the bundler would give a helper the loaded
// Worker lacks.
const run = async (fetch) => {
  const url = "http://target.test/cf";
  const forms = [
    ["none", () => fetch(url)],
    ["init", () => fetch(url, { cf: { colo: "TEST" } })],
    ["request", () => fetch(new Request(url, { cf: { colo: "REQ" } }))],
    ["requestWithInit", () =>
      fetch(new Request(url, { cf: { colo: "REQ" } }), { cf: { colo: "INIT" } })],
    ["changed", () => {
      const cf = { colo: "BEFORE" };
      const request = new Request(url, { cf });
      cf.colo = "AFTER";
      request.cf.added = 1;
      return fetch(request);
    }],
    ["json", () => fetch(url, {
      cf: { date: new Date(0), gone: undefined, fn() {}, nan: NaN, nested: { list: [1, undefined] } },
    })],
    ["array", () => fetch(url, { cf: ["a", { b: 1 }] })],
    ["noStore", () => fetch(url, { cf: { colo: "TEST" }, cache: "no-store" })],
    ["noStoreWithoutCf", () => fetch(url, { cache: "no-store" })],
    ["cacheTtl", () => fetch(url, { cf: { cacheTtl: 5 } })],
    ["post", () => fetch(url, { method: "POST", body: "x", cf: { colo: "POST" } })],
    ["unicode", () => fetch(url, { cf: { city: "Zürich \u{1F600}", "quote\"key": "a\nb" } })],
    // Still the caller's own object, which it can change.
    ["callerCopy", async () => {
      const cf = { colo: "MINE" };
      const request = new Request(url, { cf });
      await fetch(request);
      request.cf.after = true;
      return Response.json({ cf: request.cf, same: request.cf === cf, frozen: Object.isFrozen(request.cf) });
    }],
    ["bigint", () => fetch(url, { cf: { n: 1n } })],
    ["null", () => fetch(url, { cf: null })],
    ["string", () => fetch(url, { cf: "colo" })],
    ["function", () => fetch(url, { cf() {} })],
  ];
  const seen = {};
  for (const [name, send] of forms) {
    try {
      seen[name] = await (await send()).json();
    } catch (error) {
      seen[name] = { error: `${error.name}: ${error.message}` };
    }
  }
  return seen;
};

const CODE = `
  import { DurableObject } from "cloudflare:workers";
  const serve = ${serve.toString()};
  const run = ${run.toString()};
  export default {
    async fetch(request) {
      if (new URL(request.url).pathname === "/outbound")
        return Response.json(await run(fetch));
      return serve(request);
    },
  };
  export class App extends DurableObject {
    fetch(request) {
      return serve(request);
    }
  }
`;

const loaded = (env, globalOutbound) =>
  env.LOADER.get(globalOutbound ? "request-cf-forms-outbound" : "request-cf-forms", () => ({
    compatibilityDate: "2026-01-01",
    mainModule: "app.js",
    modules: { "app.js": CODE },
    ...(globalOutbound ? { globalOutbound } : {}),
  }));

export class Obj extends DurableObject {
  async fetch(request) {
    if (new URL(request.url).pathname === "/facet") {
      const facet = this.ctx.facets.get("app", () => ({
        class: loaded(this.env).getDurableObjectClass("App"),
      }));
      return Response.json(await run((input, init) => facet.fetch(input, init)));
    }
    return serve(request);
  }
}

export class Local extends WorkerEntrypoint {
  fetch(request) {
    return serve(request);
  }
}

// Forwards the request it received to `back`.
export class Forward extends WorkerEntrypoint {
  fetch(request) {
    return this.env.BACK.fetch(request);
  }
}

export default {
  async fetch(request, env, ctx) {
    if (new URL(request.url).pathname !== "/") return serve(request);
    const object = env.OBJ.getByName("a");
    const targets = {
      back: env.BACK,
      self: env.SELF,
      loopback: ctx.exports.Local,
      object,
      loader: loaded(env).getEntrypoint(),
    };
    const seen = {};
    for (const [name, target] of Object.entries(targets))
      seen[name] = await run((input, init) => target.fetch(input, init));
    seen.facet = await (await object.fetch("http://object.test/facet")).json();
    seen.globalOutbound = await (await loaded(env, ctx.exports.Local({})).getEntrypoint()
      .fetch("http://loader.test/outbound")).json();
    seen.forwarded = await (await ctx.exports.Forward.fetch("http://target.test/cf", {
      cf: { colo: "FWD" },
    })).json();
    return Response.json(seen);
  },
};
