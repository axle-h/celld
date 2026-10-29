// `ctx.exports.Obj`, for a class that also has a namespace binding, serves as
// a facet's class in workerd. celld's is the namespace only, and the facet
// refuses it: "FacetStartupOptions.class must be a DurableObjectClass."
// (plan 1.59, found by 1.30).
import { DurableObject } from "cloudflare:workers";

async function attempt(fn) {
  try {
    return await fn();
  } catch (error) {
    return `${error.name}: ${error.message}`;
  }
}

export class Obj extends DurableObject {
  calls = 0;

  count() {
    this.calls += 1;
    return this.calls;
  }

  facet() {
    const child = this.ctx.facets.get("child", () => ({ class: this.ctx.exports.Obj }));
    return attempt(() => child.count());
  }
}

export default {
  async fetch(request, env) {
    return Response.json(await env.OBJ.getByName("parent").facet());
  },
};
