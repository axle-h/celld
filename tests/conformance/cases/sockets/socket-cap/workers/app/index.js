// A request or a Durable Object holds at most CELLD_MAX_TCP_SOCKETS open
// sockets (3 in the case's env; plan 1.50). One more is refused, loudly;
// closing one makes room. workerd run locally enforces no such cap (40
// opened at once), and Cloudflare queues connections past six per
// invocation, which celld does not.
import { connect } from "cloudflare:sockets";
import { DurableObject } from "cloudflare:workers";

async function fill(port) {
  const sockets = [];
  const out = [];
  for (let i = 0; i < 4; i++) {
    try {
      const socket = connect(`127.0.0.1:${port}`);
      await socket.opened;
      sockets.push(socket);
      out.push("open");
    } catch (error) {
      out.push(`${error.name}: ${error.message}`);
    }
  }
  await sockets[0].close();
  const again = connect(`127.0.0.1:${port}`);
  await again.opened;
  out.push("open after a close");
  return out;
}

export class Holder extends DurableObject {
  fill(port) {
    return fill(port);
  }
  // Connect and drop, once per event. Without the GC-assisted recheck the
  // cap would refuse this once 32 dropped-but-uncollected sockets pile up;
  // the opened socket is not kept, so the connection it made is collected.
  async cycle(port) {
    const socket = connect(`127.0.0.1:${port}`);
    await socket.opened;
    return "connected";
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const port = url.searchParams.get("port");
    if (url.pathname === "/object") return Response.json(await env.HOLDER.getByName("a").fill(port));
    if (url.pathname === "/burst") {
      // Five connects started in one turn, all kept: the cap is taken slot
      // by slot, so exactly two are refused.
      const sockets = Array.from({ length: 5 }, () => connect(`127.0.0.1:${port}`));
      const opened = await Promise.allSettled(sockets.map((s) => s.opened));
      const refused = opened.filter((o) => o.status === "rejected").map((o) => o.reason.message);
      await Promise.allSettled(sockets.map((s) => s.close()));
      return Response.json({ opened: opened.length - refused.length, refused });
    }
    if (url.pathname === "/cycle") {
      const stub = env.HOLDER.getByName("cycler");
      const out = [];
      for (let i = 0; i < 40; i++) out.push(await stub.cycle(port));
      return Response.json(out.length + " connected, none refused");
    }
    return Response.json(await fill(port));
  },
};
