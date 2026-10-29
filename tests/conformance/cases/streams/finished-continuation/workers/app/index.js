// Request A attaches a continuation to a module-scope promise and finishes.
// Request B resolves it, so A's continuation runs during B's turn. In workerd
// the continuation runs, but a NEW subrequest it starts is tied to A's
// finished context and is refused with the cross-request error (I/O type
// SpanParent); it may still use B's live socket. celld (plan 1.54) runs the
// continuation as B, so its new fetch is not refused -- the one observable
// difference; the existing security properties (an I/O object is refused to
// any owner but its own) are unaffected.
import { connect } from "cloudflare:sockets";

let resolve;
const shared = new Promise((r) => (resolve = r));
const log = [];
let bSocket = null;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const http = url.searchParams.get("http");
    const echo = url.searchParams.get("echo");
    if (url.pathname === "/a") {
      shared.then(async () => {
        try {
          const r = await fetch(`http://127.0.0.1:${http}/echo`);
          log.push("A fetch: " + r.status);
        } catch (e) {
          log.push("A fetch: " + e.name + ": " + e.message);
        }
        try {
          const w = bSocket.writable.getWriter();
          await w.write(new TextEncoder().encode("from-A"));
          log.push("A wrote B's socket");
        } catch (e) {
          log.push("A write: " + e.name + ": " + e.message);
        }
      }, (e) => log.push("A rejected: " + e.name));
      return new Response("a done");
    }
    if (url.pathname === "/b") {
      bSocket = connect(`127.0.0.1:${echo}`);
      await bSocket.opened;
      resolve();
      await new Promise((r) => setTimeout(r, 300));
      return Response.json(log);
    }
    return new Response("?");
  },
};
