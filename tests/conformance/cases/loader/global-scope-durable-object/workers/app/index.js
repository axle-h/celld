// A Durable Object's constructor runs in the request that reached the
// object, not in global scope, so workerd lets it set a timer, draw random
// values, and make and read a body, which the Worker's module scope may not
// (loader/global-scope-io). The same holds for a facet whose class comes from
// a Dynamic Worker.
import { DurableObject } from "cloudflare:workers";

// What the constructor tries, each kept from failing the others.
const TRY = `
  const tries = {
    timer: () => { clearTimeout(setTimeout(() => {}, 1000)); return "set"; },
    random: () => crypto.randomUUID().length,
    body: () => new Response("x").text(),
    wait: () => scheduler.wait(0).then(() => "waited"),
    stream: () => new Blob(["x"]).stream().getReader().read().then((r) => r.value.length),
  };
  const results = {};
  for (const [name, attempt] of Object.entries(tries)) {
    try {
      results[name] = await attempt();
    } catch (error) {
      results[name] = error.name + ": " + error.message.slice(0, 40);
    }
  }
  return results;
`;
const attempts = new Function(`return async () => {${TRY}};`)();

const FACET = `
  import { DurableObject } from "cloudflare:workers";
  export class Facet extends DurableObject {
    constructor(ctx, env) {
      super(ctx, env);
      ctx.blockConcurrencyWhile(async () => { this.results = await (async () => {${TRY}})(); });
    }
    fetch() { return Response.json(this.results); }
  }
`;

export class Holder extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => { this.results = await attempts(); });
  }
  fetch(request) {
    if (new URL(request.url).pathname === "/facet") {
      const worker = this.env.LOADER.get("facet-v1", () => ({
        compatibilityDate: "2026-01-01",
        mainModule: "facet.js",
        modules: { "facet.js": FACET },
      }));
      const facet = this.ctx.facets.get("facet", () => ({
        class: worker.getDurableObjectClass("Facet"),
      }));
      return facet.fetch(request);
    }
    return Response.json(this.results);
  }
}

export default {
  fetch(request, env) {
    return env.HOLDER.getByName("only").fetch(request);
  },
};
