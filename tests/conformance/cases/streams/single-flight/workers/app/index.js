// A module-scope single-flight promise: the first request starts a slow
// fetch and keeps it in `shared`; a later request awaits the same promise
// while it is pending, then uses its own socket, its own fetched body and
// its own HTMLRewriter transform. The promise settles during the first
// request's work, and the later request's code after the await still runs
// as the later request (plan 1.52), so each use is its own.
import { connect } from "cloudflare:sockets";

let shared = null;
const enc = new TextEncoder();
const dec = new TextDecoder();

async function attempt(fn) {
  try {
    return { ok: await fn() };
  } catch (error) {
    return { error: `${error?.name}: ${error?.message}` };
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const http = url.searchParams.get("http");
    // /ws/log answers after 3 s when no such connection was recorded.
    shared ??= fetch(`http://127.0.0.1:${http}/ws/log?id=single-flight`).then((response) => response.json());
    if (url.pathname === "/first") {
      ctx.waitUntil(shared);
      return new Response("started");
    }
    const socket = connect(`127.0.0.1:${url.searchParams.get("echo")}`);
    await socket.opened;
    const body = (await fetch(`http://127.0.0.1:${http}/big?kib=16`)).body;
    const rewritten = new HTMLRewriter()
      .on("p", {
        async element(element) {
          await shared;
          element.setAttribute("later", "1");
        },
      })
      .transform(new Response("<p>own</p>", { headers: { "content-type": "text/html" } }));
    const html = attempt(() => rewritten.text());
    const token = await shared;
    const tcp = await attempt(async () => {
      const writer = socket.writable.getWriter();
      await writer.write(enc.encode("own"));
      const { value } = await socket.readable.getReader().read();
      return dec.decode(value);
    });
    return Response.json({
      token: token.ended,
      tcp,
      http: await attempt(async () => (await new Response(body).text()).length),
      html: await html,
    });
  },
};
