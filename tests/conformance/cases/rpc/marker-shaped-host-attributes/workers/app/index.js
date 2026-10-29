// A Request's and Response's attributes are prototype accessors over internal
// state in workerd, so own properties a script defines over them change
// nothing that crosses RPC. celld keeps them as own properties (plan 1.36,
// `workers_api_getters_setters_on_prototype`), so what it sends is what the
// script defined, each checked for its type (plan 1.53): a URL, a `cf`, a
// status, and a body that is no stream.
import { WorkerEntrypoint } from "cloudflare:workers";

export class Echo extends WorkerEntrypoint {
  async probe(arg) {
    const { v } = arg;
    if (v instanceof Request) return [v.url, v.cf ?? null, await v.text()];
    if (v instanceof Response) return [v.status, await v.text()];
    return typeof v;
  }
}

const define = (value, key, field) => {
  Object.defineProperty(value, key, { value: field, enumerable: true, writable: true, configurable: true });
  return value;
};

const CASES = {
  url: () => define(new Request("https://example.com/"), "url", "https://elsewhere.example/"),
  cf: () => define(new Request("https://example.com/"), "cf", { colo: "forged" }),
  status: () => define(new Response("x"), "status", 299),
  body: () => define(new Request("https://example.com/", { method: "POST", body: "x" }), "body", 5),
};

export default {
  async fetch(request, env, ctx) {
    const out = {};
    for (const [name, make] of Object.entries(CASES)) {
      try {
        out[name] = await ctx.exports.Echo.probe({ v: make() });
      } catch (error) {
        out[name] = `${error.name}: ${error.message}`;
      }
    }
    return Response.json(out);
  },
};
