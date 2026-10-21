// Every incoming request has redirect mode "manual", whatever mode the caller
// used: at the top level, and in each target of a fetch from another Worker.
// So a Worker that forwards the request it received through a binding
// (`/forward*`) passes the target's redirect back to its client instead of
// following it. `redirect-outside` covers forwarding it to the network.
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

// Each entrypoint reports the redirect mode it receives on `/mode`, and
// answers any other path with a 302.
const CODE = `
  import { DurableObject } from "cloudflare:workers";
  const handle = (request, who) => new URL(request.url).pathname === "/mode"
    ? Response.json(request.redirect)
    : new Response(who + " redirects", { status: 302, headers: { location: "/landed?from=" + who } });
  export default { fetch: (request) => handle(request, "loader") };
  export class App extends DurableObject {
    fetch(request) { return handle(request, "facet"); }
  }
`;

const loaded = (env) =>
  env.LOADER.get("redirect-v1", () => ({
    compatibilityDate: "2026-01-01",
    mainModule: "app.js",
    modules: { "app.js": CODE },
  }));

// The mode a target sees for each mode its caller sends.
async function modes(target, url = "http://target.test/mode") {
  const seen = {};
  for (const redirect of ["follow", "manual"]) {
    seen[redirect] = await (await target.fetch(url, { redirect })).json();
  }
  return seen;
}

export class Obj extends DurableObject {
  facet() {
    return this.ctx.facets.get("app", () => ({
      class: loaded(this.env).getDurableObjectClass("App"),
    }));
  }

  async fetch(request) {
    switch (new URL(request.url).pathname) {
      case "/mode":
        return Response.json(request.redirect);
      case "/facet":
        return Response.json(await modes(this.facet()));
      case "/forward-facet":
        return this.facet().fetch(request);
      default:
        return new Response("object redirects", { status: 302, headers: { location: "/landed?from=object" } });
    }
  }
}

export class Local extends WorkerEntrypoint {
  fetch(request) {
    switch (new URL(request.url).pathname) {
      case "/mode":
        return Response.json(request.redirect);
      default:
        return new Response("loopback redirects", { status: 302, headers: { location: "/landed?from=loopback" } });
    }
  }
}

// Set while `/forward-self` waits on the SELF binding. The binding delivers
// the same URL to this handler in this isolate, so this is how the second hop
// knows to answer instead of forwarding again.
let forwardingToSelf = false;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    switch (url.pathname) {
      case "/mode":
        return Response.json(request.redirect);
      // Where a followed redirect would land.
      case "/landed":
        return Response.json({ landed: url.search });
      case "/forward":
        return env.BACK.fetch(request);
      case "/forward-named":
        return env.BACK_NAMED.fetch(request);
      case "/forward-loopback":
        return ctx.exports.Local.fetch(request);
      case "/forward-self":
        if (forwardingToSelf) {
          return new Response("self redirects", { status: 302, headers: { location: "/landed?from=self" } });
        }
        forwardingToSelf = true;
        try {
          return await env.SELF.fetch(request);
        } finally {
          forwardingToSelf = false;
        }
      case "/forward-object":
        return env.OBJ.getByName("a").fetch(request);
      case "/forward-facet":
        return env.OBJ.getByName("a").fetch(request);
      case "/forward-loader":
        return loaded(env).getEntrypoint().fetch(request);
      case "/modes":
        return Response.json({
          top: request.redirect,
          copies: {
            request: new Request(request).redirect,
            urlAndRequest: new Request("http://copy.test/", request).redirect,
            clone: request.clone().redirect,
            overridden: new Request(request, { redirect: "follow" }).redirect,
          },
          back: await modes(env.BACK),
          backNamed: await modes(env.BACK_NAMED),
          selfBinding: await modes(env.SELF),
          loopbackDefault: await modes(ctx.exports.default),
          loopbackNamed: await modes(ctx.exports.Local),
          loopbackProps: await modes(ctx.exports.Local({ props: { who: "props" } })),
          object: await modes(env.OBJ.getByName("a")),
          facet: await (await env.OBJ.getByName("a").fetch("http://object.test/facet")).json(),
          loader: await modes(loaded(env).getEntrypoint()),
        });
      default:
        return new Response("not found", { status: 404 });
    }
  },
};
