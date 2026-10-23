// Clients that send auto-response requests and never read the replies
// (plan 1.22). The object answers "p" with 2000 bytes, in the host, which
// stops reading a socket while its replies wait, as workerd waits for each
// one to be written before it reads on. Two clients each send 100,000
// requests, which would be 200 MB of replies each, and the node's memory
// stays bounded: twenty clients with 16,000 each took it from 51 to 668 MiB
// before.
import { DurableObject } from "cloudflare:workers";

export class Sockets extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("p", "y".repeat(2000)));
  }

  fetch(request) {
    if (new URL(request.url).pathname === "/warm") return new Response("warm");
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }
}

export default {
  fetch(request, env) {
    return env.SOCKETS.getByName("sockets").fetch(request);
  },
};
