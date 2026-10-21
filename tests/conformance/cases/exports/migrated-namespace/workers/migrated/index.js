// ctx.exports namespaces for Durable Object classes declared only in
// migrations: their shape, their ids, an RPC call, and storage that outlives
// a restart. Also which other exports `ctx.exports` lists: a class with no
// storage is a class for facets, and a workflow class is not there.
import { DurableObject, WorkflowEntrypoint, exports } from "cloudflare:workers";

export class Bound extends DurableObject {
  whoami() {
    return "bound";
  }
}

export class Migrated extends DurableObject {
  async add(n) {
    const total = ((await this.ctx.storage.get("total")) ?? 0) + n;
    await this.ctx.storage.put("total", total);
    return total;
  }
  async total() {
    return (await this.ctx.storage.get("total")) ?? 0;
  }
  async freeFacet() {
    const facet = this.ctx.facets.get("free", () => ({ class: this.ctx.exports.Free }));
    return (await facet.fetch("http://free.test/")).text();
  }
}

// No `extends DurableObject`: workerd still treats it as a Durable Object
// class, reached by `fetch`.
export class Plain {
  fetch() {
    return new Response("plain");
  }
}

// No migration and no binding: a class for facets, not a namespace.
export class Free {
  fetch() {
    return new Response("free");
  }
}

// Neither a namespace nor a class in `ctx.exports`, on workerd. celld's
// workflow class for this script must not appear there either.
export class Flow extends WorkflowEntrypoint {
  async run() {}
}

const NAMESPACE_METHODS = ["get", "getByName", "idFromName", "idFromString", "newUniqueId"];

// Not `typeof namespace`: workerd's namespace is also callable, which is
// plan item 2.3.
function shape(namespace) {
  return Object.fromEntries(NAMESPACE_METHODS.map((name) => [name, typeof namespace?.[name]]));
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    switch (url.pathname) {
      case "/shape":
        return Response.json({
          // wrangler adds `__INTERNAL_WRANGLER_MIDDLEWARE__`.
          keys: Object.keys(ctx.exports)
            .filter((name) => name !== "__INTERNAL_WRANGLER_MIDDLEWARE__")
            .sort(),
          Bound: shape(ctx.exports.Bound),
          Migrated: shape(ctx.exports.Migrated),
          Plain: shape(ctx.exports.Plain),
          imported: shape(exports.Migrated),
          Free: { type: typeof ctx.exports.Free, getByName: typeof ctx.exports.Free?.getByName },
        });
      case "/ids": {
        const id = (namespace) => namespace.idFromName("a").toString();
        return Response.json({
          boundMatchesBinding: ctx.exports.Bound.getByName("a").id.toString() === id(env.BOUND),
          bindingMatchesExport: env.BOUND.idFromName("a").equals(ctx.exports.Bound.idFromName("a")),
          migratedByName: ctx.exports.Migrated.getByName("a").id.toString() === id(ctx.exports.Migrated),
          importMatchesCtx: id(exports.Migrated) === id(ctx.exports.Migrated),
          classesDiffer: id(ctx.exports.Migrated) !== id(ctx.exports.Bound),
          roundTrips: ctx.exports.Migrated.idFromString(id(ctx.exports.Migrated)).toString() === id(ctx.exports.Migrated),
        });
      }
      case "/add":
        return Response.json({ total: await ctx.exports.Migrated.getByName("a").add(Number(url.searchParams.get("n"))) });
      case "/total":
        return Response.json({ total: await ctx.exports.Migrated.getByName("a").total() });
      case "/plain": {
        const response = await ctx.exports.Plain.getByName("a").fetch("http://plain.test/");
        return Response.json({ status: response.status, body: await response.text() });
      }
      case "/free":
        return Response.json({ body: await ctx.exports.Migrated.getByName("a").freeFacet() });
      case "/bound":
        return Response.json({
          viaExports: await ctx.exports.Bound.getByName("a").whoami(),
          viaBinding: await env.BOUND.get(env.BOUND.idFromName("a")).whoami(),
        });
      default:
        return new Response("not found", { status: 404 });
    }
  },
};
