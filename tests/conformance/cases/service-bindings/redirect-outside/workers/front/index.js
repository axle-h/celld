// A Worker that forwards the request it received to the network with
// `fetch(request)` gets a redirect back instead of following it, because an
// incoming request has redirect mode "manual". The runner's upstream server
// (`lib/upstream.mjs`) is the redirecting server the forwarded requests reach
// over the network: its `/bounce` answers 302 to `/landed`. Each target of
// `/outside` receives a request for it.
//
// The upstream is on loopback, which celld's egress policy refuses, so the
// case allows exactly its address with CELLD_FETCH_PRIVATE_ALLOW.
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
    const bounce = `http://127.0.0.1:${url.searchParams.get("upstream")}/bounce`;
    // The caller's own mode, so that only the target's mode decides whether
    // the 302 is followed. With the default mode, the binding would follow
    // the 302 itself, back through the same target
    // (service-bindings/redirect-follow).
    const manual = { redirect: "manual" };
    switch (url.pathname) {
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
