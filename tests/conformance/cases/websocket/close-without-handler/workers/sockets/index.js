// A client closes a WebSocket whose Worker never calls close() in reply.
//
// /hibernatable: a socket accepted with ctx.acceptWebSocket by an object that
// exports no webSocketClose handler. workerd 1.20261001.1 sends no Close
// frame back for a hibernatable socket, whatever the compatibility date.
//
// /accepted: a socket accepted with accept() and no close listener. Before
// web_socket_auto_reply_to_close (2026-04-07) workerd sends no Close frame
// back either.
//
// In both, the client never completes the closing handshake and reports 1006.
import { DurableObject } from "cloudflare:workers";

export class Sockets extends DurableObject {
  fetch() {
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[0]);
    return new Response(null, { status: 101, webSocket: pair[1] });
  }

  webSocketMessage(ws, message) {
    ws.send(`echo:${message}`);
  }
}

export default {
  fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === "/hibernatable") return env.SOCKETS.getByName("sockets").fetch(request);
    if (pathname === "/accepted") {
      const pair = new WebSocketPair();
      const server = pair[0];
      server.accept();
      server.addEventListener("message", (event) => server.send(`echo:${event.data}`));
      return new Response(null, { status: 101, webSocket: pair[1] });
    }
    return new Response("not found", { status: 404 });
  },
};
