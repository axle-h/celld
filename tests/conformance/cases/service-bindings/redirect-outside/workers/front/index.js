// A Worker that forwards the request it received to the network with
// `fetch(request)` gets a redirect back instead of following it, because an
// incoming request has redirect mode "manual". `/bounce`, on this Worker's own
// origin, is the redirecting server the forwarded requests reach over the
// network; each target of `/outside` receives a request for it.
//
// The redirecting server is on loopback. Once plan 1.9 refuses private
// addresses, the runner has to allowlist this node's public address for it.
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

async function summary(response) {
  return {
    status: response.status,
    location: response.headers.get("location"),
    body: await response.text(),
  };
}

export class Obj extends DurableObject {
  fetch(request) {
    return fetch(request);
  }
}

export class Local extends WorkerEntrypoint {
  fetch(request) {
    return fetch(request);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const bounce = new URL("/bounce", url).href;
    // The caller's own mode, so that only the target's mode decides whether
    // the 302 is followed. With the default mode, workerd's Durable Object
    // stub would follow the 302 itself, and celld's doesn't yet (plan 1.20).
    const manual = { redirect: "manual" };
    switch (url.pathname) {
      case "/bounce":
        return new Response("bounce", { status: 302, headers: { location: "/landed?from=bounce" } });
      case "/landed":
        return Response.json({ landed: url.search });
      case "/outside":
        return Response.json({
          // The control: a request made with the default mode follows.
          follow: await summary(await fetch(bounce)),
          top: await summary(await fetch(new Request(bounce, request))),
          object: await summary(await env.OBJ.getByName("a").fetch(bounce, manual)),
          back: await summary(await env.BACK.fetch(bounce, manual)),
          backNamed: await summary(await env.BACK_NAMED.fetch(bounce, manual)),
          loopback: await summary(await ctx.exports.Local.fetch(bounce, manual)),
          loopbackProps: await summary(await ctx.exports.Local({ props: {} }).fetch(bounce, manual)),
        });
      default:
        return new Response("not found", { status: 404 });
    }
  },
};
