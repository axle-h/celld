// Both entrypoints answer `/mode` with the redirect mode of the request they
// received, and every other path with a 302.
import { WorkerEntrypoint } from "cloudflare:workers";

function handle(request, who) {
  switch (new URL(request.url).pathname) {
    case "/mode":
      return Response.json(request.redirect);
    default:
      return new Response(`${who} redirects`, { status: 302, headers: { location: `/landed?from=${who}` } });
  }
}

export class Named extends WorkerEntrypoint {
  fetch(request) {
    return handle(request, "back-named");
  }
}

export default {
  fetch(request) {
    return handle(request, "back");
  },
};
