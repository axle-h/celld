// examples/wsecho through the hibernation API (ctx.acceptWebSocket), with a
// webSocketClose handler so both sides of the close handshake are the
// Worker's own. Nothing here makes the object hibernate; a restart drops the
// socket. websocket/close-without-handler covers the missing handler.
import { DurableObject } from "cloudflare:workers";

export class Echo extends DurableObject {
  fetch(request) {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("websocket upgrade required", { status: 426 });
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[0]);
    return new Response(null, { status: 101, webSocket: pair[1] });
  }

  webSocketMessage(ws, message) {
    if (message === "bye") {
      ws.close(4001, "server closed");
      return;
    }
    const count = (this.ctx.storage.kv.get("count") ?? 0) + 1;
    this.ctx.storage.kv.put("count", count);
    ws.send(JSON.stringify({ echo: message, count }));
  }

  webSocketClose(ws, code, reason) {
    ws.close(code, `closed ${code} ${reason}`.trim());
  }
}

export default {
  fetch(request, env) {
    return env.ECHO.getByName("echo").fetch(request);
  },
};
