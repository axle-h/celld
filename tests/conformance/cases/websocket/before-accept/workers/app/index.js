// What a WebSocket that a subrequest's 101 returned does before accept()
// (plan 1.22): its readyState, send() and close(), and what reaches the
// server end once it is accepted. The socket comes from a service binding
// (`/handoff`), from a Durable Object's `stub.fetch` (`/object`), or is the
// unaccepted end of a WebSocketPair (`/pair`).
// websocket/before-accept-fetched has a socket from a fetch() upgrade.
import { DurableObject } from "cloudflare:workers";

export class Sockets extends DurableObject {
  fetch() {
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    server.addEventListener("message", (event) => server.send(`object:${event.data}`));
    server.addEventListener("close", (event) => server.close(event.code, `object saw ${event.code}`));
    return new Response(null, { status: 101, webSocket: client });
  }
}

const attempt = (use) => {
  try {
    use();
    return "allowed";
  } catch (error) {
    return `${error.name}: ${error.message}`;
  }
};

// Use the socket before and after accept(), and record what arrives until
// its close event, or for 500 ms.
async function probe(socket) {
  const seen = { before: socket.readyState };
  seen.send = attempt(() => socket.send("early"));
  seen.close = attempt(() => socket.close(4000, "early"));
  seen.afterClose = socket.readyState;
  const events = [];
  const closed = new Promise((resolve) => {
    socket.addEventListener("message", (event) => events.push(["message", event.data]));
    socket.addEventListener("close", (event) => {
      events.push(["close", event.code, event.reason]);
      resolve();
    });
  });
  seen.accept = attempt(() => socket.accept());
  seen.accepted = socket.readyState;
  seen.ping = attempt(() => socket.send("ping"));
  await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 500))]);
  seen.events = events;
  seen.after = socket.readyState;
  seen.closeAfter = attempt(() => socket.close(4001, "late"));
  return seen;
}

const upgrade = { headers: { Upgrade: "websocket" } };

export default {
  async fetch(request, env) {
    switch (new URL(request.url).pathname) {
      case "/handoff":
        return Response.json(await probe((await env.BACK.fetch("http://back/", upgrade)).webSocket));
      case "/object": {
        const stub = env.SOCKETS.getByName("sockets");
        return Response.json(await probe((await stub.fetch("http://object/", upgrade)).webSocket));
      }
      case "/pair": {
        const [client, server] = Object.values(new WebSocketPair());
        const seen = {
          before: client.readyState,
          send: attempt(() => client.send("early")),
          close: attempt(() => client.close(4000, "early")),
          after: client.readyState,
        };
        server.accept();
        return Response.json(seen);
      }
    }
    return new Response("not found", { status: 404 });
  },
};
