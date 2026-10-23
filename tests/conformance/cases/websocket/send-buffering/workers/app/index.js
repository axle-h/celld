// A Worker sends faster than its client reads (plan 1.22). On
// `flood:<count>:<size>` the server end sends `count` messages of `size`
// bytes at once, while the client reads nothing for a while. send() never
// waits and never throws, and there is no `bufferedAmount`: the messages
// queue, and all of them arrive once the client reads. The server end is a
// stateless Worker's (`/stateless`) or a Durable Object's (`/object`), and
// `/seen` answers what each saw.
// websocket/send-queue-overflow has what celld does past its queue limit.
import { DurableObject } from "cloudflare:workers";

function serve(log) {
  const [client, server] = Object.values(new WebSocketPair());
  server.accept();
  server.addEventListener("message", (event) => {
    const [, count, size] = String(event.data).split(":").map(Number);
    const message = "x".repeat(size);
    let thrown = null;
    for (let sent = 0; sent < count && thrown === null; sent++) {
      try {
        server.send(message);
      } catch (error) {
        thrown = `${sent}: ${error.name}: ${error.message}`;
      }
    }
    log(["flooded", thrown, typeof server.bufferedAmount, server.readyState]);
  });
  server.addEventListener("close", (event) => log(["close", event.code, event.reason, event.wasClean]));
  return new Response(null, { status: 101, webSocket: client });
}

export class Sockets extends DurableObject {
  seen = [];
  fetch(request) {
    if (new URL(request.url).pathname === "/seen") return Response.json(this.seen);
    return serve((entry) => this.seen.push(entry));
  }
}

// The stateless entries live in this isolate (the case's env).
const seen = [];

export default {
  async fetch(request, env) {
    const object = env.SOCKETS.getByName("sockets");
    switch (new URL(request.url).pathname) {
      case "/stateless":
        return serve((entry) => seen.push(entry));
      case "/object":
        return object.fetch(request);
      case "/seen":
        return Response.json({ stateless: seen, object: await (await object.fetch(request)).json() });
    }
    return new Response("not found", { status: 404 });
  },
};
