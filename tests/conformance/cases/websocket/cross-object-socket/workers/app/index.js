// One Durable Object's ctx and socket, used during another object's event
// in the same isolate (plan 1.21). As in workerd, the ctx's WebSocket
// methods act on the running object, and the other object's socket refuses
// I/O with the cross-object error. Object "a" then uses its own.
import { DurableObject } from "cloudflare:workers";

const leaked = {};

export class Room extends DurableObject {
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/hold")) {
      leaked.ctx = this.ctx;
      const [, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server, ["held"]);
      leaked.ws = server;
      return new Response("held");
    }
    const { ctx, ws } = leaked;
    const outcome = {};
    for (const [name, use] of Object.entries({
      getWebSockets: () => ctx.getWebSockets().length,
      getTags: () => ctx.getTags(ws),
      autoResponse: () => {
        ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
        return ctx.getWebSocketAutoResponse().response;
      },
      timestamp: () => ctx.getWebSocketAutoResponseTimestamp(ws),
      send: () => ws.send("x"),
      attachment: () => {
        ws.serializeAttachment(1);
        return ws.deserializeAttachment();
      },
      close: () => ws.close(1000, "done"),
    })) {
      try {
        outcome[name] = use() ?? "ok";
      } catch (error) {
        outcome[name] = `${error.name}: ${error.message}`;
      }
    }
    return Response.json(outcome);
  }
}

export default {
  fetch(request, env) {
    const name = new URL(request.url).pathname.split("/")[1];
    return env.ROOM.getByName(name).fetch(request);
  },
};
