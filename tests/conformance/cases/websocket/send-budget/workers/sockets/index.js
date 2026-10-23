// Many sockets, each under its own 32 MiB bound, together hold no more than
// their isolate's memory budget (plan 1.22). Each request accepts 10
// hibernatable sockets whose other end nothing reads, and sends 31 MiB on
// each, so the host holds what they send. Past the budget the sockets that
// cannot queue more close, and the node's memory stays bounded: 40 sockets
// held 1.3 GB before.
import { DurableObject } from "cloudflare:workers";

export class Sockets extends DurableObject {
  kept = [];

  fetch(request) {
    if (new URL(request.url).pathname === "/warm") return new Response("sockets 0");
    const message = "x".repeat(1 << 20);
    for (let socket = 0; socket < 10; socket++) {
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server);
      for (let sent = 0; sent < 31; sent++) server.send(message);
      this.kept.push(client);
    }
    return new Response(`sockets ${this.ctx.getWebSockets().length}`);
  }
}

export default {
  fetch(request, env) {
    return env.SOCKETS.getByName("sockets").fetch(request);
  },
};
