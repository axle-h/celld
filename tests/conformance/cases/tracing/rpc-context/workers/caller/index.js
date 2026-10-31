// Calls each RPC path, and a service binding's and a loaded Worker's fetch(),
// inside a custom span, so the transcript shows whether the callee's spans
// join the caller's trace. `/loopback` is the one path that stays in the
// caller's isolate.
import { DurableObject, WorkerEntrypoint, tracing } from "cloudflare:workers";

// A traceparent the application sets itself. A Worker's fetch() carries its
// caller's context from the host, so the target's spans join the caller's
// trace and this header is only data (plan 1.41).
const APP_TRACEPARENT = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";

// A loaded Worker: a fetch handler for `/loader-fetch`, an entrypoint for
// `/loader`, a facet class for `/facet`.
const CODE = `
  import { DurableObject, WorkerEntrypoint, tracing } from "cloudflare:workers";
  export default {
    fetch() {
      return tracing.enterSpan("in-loader-fetch", (span) => new Response(String(span.isTraced)));
    },
  };
  export class Tool extends WorkerEntrypoint {
    run() {
      return tracing.enterSpan("in-loader", (span) => {
        span.setAttribute("side", "loader");
        return "ran";
      });
    }
  }
  export class App extends DurableObject {
    ping() {
      return tracing.enterSpan("in-facet", (span) => {
        span.setAttribute("side", "facet");
        return "pinged";
      });
    }
  }
`;

const loaded = (env) =>
  env.LOADER.get("tools-v1", () => ({
    compatibilityDate: "2026-01-01",
    mainModule: "tools.js",
    modules: { "tools.js": CODE },
  }));

export class Local extends WorkerEntrypoint {
  work() {
    return tracing.enterSpan("in-loopback", (span) => {
      span.setAttribute("side", "loopback");
      return "looped";
    });
  }
}

export class Host extends DurableObject {
  async viaFacet() {
    return tracing.enterSpan("around-host", () => {
      const facet = this.ctx.facets.get("app", () => ({
        class: loaded(this.env).getDurableObjectClass("App"),
      }));
      return tracing.enterSpan("around-facet", () => facet.ping());
    });
  }
}

export default {
  async fetch(request, env, ctx) {
    switch (new URL(request.url).pathname) {
      case "/service":
        return tracing.enterSpan("around-service", async () => new Response(await env.CALLEE.work()));
      case "/loader":
        return tracing.enterSpan(
          "around-loader",
          async () => new Response(await loaded(env).getEntrypoint("Tool").run()),
        );
      case "/loopback":
        return tracing.enterSpan("around-loopback", async () => new Response(await ctx.exports.Local.work()));
      case "/service-fetch":
        return tracing.enterSpan("around-service-fetch", async () => {
          const own = await (await env.CALLEE.fetch("http://callee/")).text();
          const app = await (await env.CALLEE.fetch("http://callee/", { headers: { traceparent: APP_TRACEPARENT } })).text();
          return Response.json({ own, app });
        });
      case "/loader-fetch":
        return tracing.enterSpan("around-loader-fetch", async () => {
          const entry = loaded(env).getEntrypoint();
          const own = await (await entry.fetch("http://loaded/")).text();
          const app = await (await entry.fetch("http://loaded/", { headers: { traceparent: APP_TRACEPARENT } })).text();
          return Response.json({ own, app });
        });
      case "/facet":
        return new Response(await env.HOST.getByName("host").viaFacet());
      default:
        return new Response("not found", { status: 404 });
    }
  },
};
