// A Durable Object closes an accepted WebSocket first. The socket is CLOSING
// until the client's reply arrives, and then its close event fires with the
// client's code (plan item 1.22).
import { DurableObject } from "cloudflare:workers";

export class Sockets extends DurableObject {
  seen = [];

  fetch(request) {
    if (new URL(request.url).pathname === "/seen") return Response.json(this.seen);
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    server.addEventListener("message", () => {
      server.close(4040, "server closes");
      this.seen.push(["after close()", server.readyState]);
    });
    server.addEventListener("close", (event) => {
      this.seen.push(["close", event.code, event.wasClean, server.readyState]);
    });
    return new Response(null, { status: 101, webSocket: client });
  }
}

export default {
  fetch(request, env) {
    return env.SOCKETS.getByName("sockets").fetch(request);
  },
};
