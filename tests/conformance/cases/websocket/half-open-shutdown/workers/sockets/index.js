// A client sends its Close to a half-open socket, whose close listener does
// not reply (before 2026-04-07, so nothing replies automatically), and then
// shuts down its side of the connection. workerd reads nothing after the
// Close, so it keeps the connection until the object writes to it. celld
// keeps it too, while a Ping now and then finds the client still there
// (plan item 1.22).
import { DurableObject } from "cloudflare:workers";

export class Sockets extends DurableObject {
  seen = [];

  fetch(request) {
    if (new URL(request.url).pathname === "/seen") return Response.json(this.seen);
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    server.addEventListener("message", (event) => server.send(`echo:${event.data}`));
    server.addEventListener("close", (event) => {
      this.seen.push(["close", event.code, server.readyState]);
    });
    return new Response(null, { status: 101, webSocket: client });
  }
}

export default {
  fetch(request, env) {
    return env.SOCKETS.getByName("sockets").fetch(request);
  },
};
