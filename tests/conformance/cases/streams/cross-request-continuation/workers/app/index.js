// A continuation of one request that a later request's code resolves still
// runs as the request that created it, in workerd: after the later request
// resolves the promise the first is waiting on, the first request's work uses
// its own socket, its own fetched body and its own HTMLRewriter transform.
// celld runs a stateless request's continuation as whichever request's turn
// resolved it (plan 1.52), so each use is refused as cross-request I/O.
import { connect } from "cloudflare:sockets";

let release;
let output = null;
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
    if (url.pathname === "/hold") {
      const waiting = new Promise((resolve) => {
        release = resolve;
        setTimeout(resolve, 5000);
      });
      const socket = connect(`127.0.0.1:${url.searchParams.get("echo")}`);
      await socket.opened;
      const body = (await fetch(`http://127.0.0.1:${url.searchParams.get("http")}/big?kib=16`)).body;
      const rewritten = new HTMLRewriter()
        .on("p", {
          async element(element) {
            await waiting;
            element.setAttribute("later", "1");
          },
        })
        .transform(new Response("<p>held</p>", { headers: { "content-type": "text/html" } }));
      ctx.waitUntil((async () => {
        const html = attempt(() => rewritten.text());
        await waiting;
        const tcp = await attempt(async () => {
          const writer = socket.writable.getWriter();
          await writer.write(enc.encode("later"));
          const { value } = await socket.readable.getReader().read();
          return dec.decode(value);
        });
        const http = await attempt(async () => (await new Response(body).text()).length);
        output = { tcp, http, html: await html };
      })());
      return new Response("holding");
    }
    if (url.pathname === "/report") {
      release();
      for (let i = 0; output === null && i < 50; i++) await new Promise((resolve) => setTimeout(resolve, 50));
      return Response.json(output);
    }
    return new Response("not found", { status: 404 });
  },
};
