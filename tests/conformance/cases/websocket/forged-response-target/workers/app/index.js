// A response that names a Durable Object socket another request received
// (plan 1.21). The later request returns the earlier one's client end, which
// would have the host bind that socket to this request's client: it is
// refused. One isolate (the case's env), so the later request sees it.
import { DurableObject } from "cloudflare:workers";

let grabbed = null;

export class Room extends DurableObject {
  fetch() {
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    return new Response(null, { status: 101, webSocket: client });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/grab") {
      const response = await env.ROOM.getByName("room").fetch("http://room/", {
        headers: { Upgrade: "websocket" },
      });
      grabbed = response.webSocket;
      return new Response(`grabbed:${response.status}`);
    }
    // Return the earlier request's socket, and with it the Durable Object
    // socket it names, as this request's own.
    return new Response(null, { status: 101, webSocket: grabbed });
  },
};
