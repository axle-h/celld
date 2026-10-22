// The same server as front's `serve`, behind both entrypoints.
import { WorkerEntrypoint } from "cloudflare:workers";

// Not Content-Length: celld doesn't add it to a byte body yet
// (service-bindings/body-length, plan 1.41).
const ECHOED = [
  "host", "authorization", "cookie", "proxy-authorization", "x-custom",
  "content-type", "transfer-encoding",
];

async function serve(request, who) {
  const url = new URL(request.url);
  const query = url.searchParams;
  switch (url.pathname) {
    case "/echo": {
      const report = JSON.stringify({
        who,
        url: request.url,
        method: request.method,
        redirect: request.redirect,
        headers: Object.fromEntries(ECHOED.map((name) => [name, request.headers.get(name)])),
        body: await request.text(),
      });
      return new Response(report, { headers: { "content-type": "application/json", "x-echo": report } });
    }
    case "/redirect": {
      const headers = query.has("to") ? { location: query.get("to") } : {};
      return new Response("redirect", { status: Number(query.get("status") ?? 302), headers });
    }
    case "/chain": {
      const n = Number(query.get("n"));
      return new Response("chain", { status: 302, headers: { location: n > 0 ? `/chain?n=${n - 1}` : "/echo" } });
    }
    case "/loop":
      return new Response("loop", { status: 302, headers: { location: "/loop" } });
    case "/cf":
      return Response.json(request.cf ?? null);
    default:
      return new Response("not found", { status: 404 });
  }
}

export class Named extends WorkerEntrypoint {
  fetch(request) {
    return serve(request, "back-named");
  }
}

export default {
  fetch(request) {
    return serve(request, "back");
  },
};
