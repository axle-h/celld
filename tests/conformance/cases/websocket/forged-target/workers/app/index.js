// Forging a WebSocket from what a script can write (plan 1.21). Each attempt
// must be refused: a number is a URL, not a socket id; a Response takes no
// target and no object that is not a WebSocket; and the client end of a
// Durable Object's socket that an earlier request received cannot be used
// by a later one. One isolate (the case's env), so the later request sees it.
import { DurableObject } from "cloudflare:workers";

let grabbed = null;

export class Room extends DurableObject {
  fetch() {
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    return new Response(null, { status: 101, webSocket: client });
  }
}

const refused = (attempt) => {
  try {
    attempt();
    return "allowed";
  } catch (error) {
    return error.message.startsWith("Cannot perform I/O on behalf of a different request")
      ? "cross-request"
      : error.name;
  }
};

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
    return Response.json({
      numericId: refused(() => new WebSocket(1)),
      targetInit: refused(() => new Response(null, {
        status: 101,
        __wsTarget: { id: 1, scope: "room" },
      })),
      fakeSocket: refused(() => new Response(null, {
        status: 101,
        webSocket: { accept() {}, send() {} },
      })),
      grabbedAccept: refused(() => grabbed.accept()),
      grabbedSend: refused(() => grabbed.send("x")),
    });
  },
};
