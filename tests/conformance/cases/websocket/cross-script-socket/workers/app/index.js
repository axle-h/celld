// Another script reaching this script's sockets (plan 1.21). The socket in
// the first step is this script's; the second step's script tries to name
// it. A socket id is no longer something a script can write, so every
// attempt is refused in that script.
import { DurableObject } from "cloudflare:workers";

export class Room extends DurableObject {
  fetch() {
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }
  webSocketMessage(ws, message) {
    ws.send(`room:${message}`);
  }
  webSocketClose(ws, code) {
    ws.close(code, "room closed");
  }
}

export default {
  fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/socket") return env.ROOM.getByName("room").fetch(request);
    return env.OTHER.fetch(request);
  },
};
