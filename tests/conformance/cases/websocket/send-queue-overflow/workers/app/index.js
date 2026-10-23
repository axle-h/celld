// A Worker sends 100 MB to a client that reads nothing (plan 1.22). workerd
// queues it all (websocket/send-buffering). celld holds at most
// WS_OUT_QUEUE_MAX_BYTES (32 MiB) for one socket: past that it drops the
// connection, and the server end closes abnormally with celld's reason. The
// node's memory grows by about the limit, not by what was sent (about 60 MiB
// measured locally and 131 MiB on CI, checked against 192 MiB).
// - /stateless and /object: the server end of a stateless Worker or a
//   Durable Object floods on `flood:<count>:<size>`.
// - /parked: `back` floods the socket it returns before the front accepts
//   it, so the frames wait in the host's buffer for the handed-over socket.
//   The front's end gets the overflow's Close, and `back`'s end closes
//   abnormally.
// `/seen` answers what each end saw.
import { DurableObject } from "cloudflare:workers";

function listen(socket, log) {
  socket.addEventListener("error", (event) => log(["error", event.message]));
  socket.addEventListener("close", (event) => log(["close", event.code, event.reason, event.wasClean]));
}

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
    log(["flooded", thrown, server.readyState]);
  });
  listen(server, log);
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
const seen = { stateless: [], parked: [] };

export default {
  async fetch(request, env) {
    const object = env.SOCKETS.getByName("sockets");
    switch (new URL(request.url).pathname) {
      case "/warm":
        return new Response("warm");
      case "/stateless":
        return serve((entry) => seen.stateless.push(entry));
      case "/object":
        return object.fetch(request);
      case "/parked": {
        const socket = (await env.BACK.fetch("http://back/", { headers: { Upgrade: "websocket" } })).webSocket;
        // `back` flooded the socket before it returned it.
        await new Promise((resolve) => setTimeout(resolve, 500));
        const closed = new Promise((resolve) => socket.addEventListener("close", resolve));
        listen(socket, (entry) => seen.parked.push(entry));
        socket.accept();
        await closed;
        return Response.json(seen.parked);
      }
      case "/seen":
        return Response.json({
          ...seen,
          object: await (await object.fetch(request)).json(),
          back: await (await env.BACK.fetch("http://back/seen")).json(),
        });
    }
    return new Response("not found", { status: 404 });
  },
};
