// workerd reports the end of a socket's connection as an error event,
// "Network connection lost.", on the end that replies to its peer's Close
// in the same turn, automatically or from its close listener, after its
// close event (plan 1.42). The end that closed first, an end that replies
// later, and a hibernatable socket report nothing. Each path a socket's
// frames take here does the same: a pair returned to the client by a
// stateless Worker or a Durable Object, a pair both of whose ends this
// isolate accepted, and a Durable Object's socket that a stateless request
// accepted from `stub.fetch`. websocket/error-after-close has the first. A
// Durable Object's hibernatable socket reports nothing either way: neither
// when its client closes first and `webSocketClose` replies, nor when the
// object closes first.
// `/seen` answers what each end saw, which lives in this isolate (the
// case's env) and in the object.
import { DurableObject } from "cloudflare:workers";

const seen = {};
const log = (key, entry) => (seen[key] ??= []).push(entry);
const watch = (socket, record) => {
  socket.addEventListener("error", (event) => record(["error", event.message, String(event.error)]));
  socket.addEventListener("close", (event) => record(["close", event.code, event.reason, event.wasClean]));
};

// The server end of a pair: it echoes, closes first on "first", and with
// `?half` replies to a Close from its close listener, or with `?late` 100 ms
// later.
const serve = (url, record) => {
  const [client, server] = Object.values(new WebSocketPair());
  const half = url.searchParams.has("half") || url.searchParams.has("late");
  server.accept(half ? { allowHalfOpen: true } : undefined);
  server.addEventListener("message", (event) => {
    if (event.data === "first") server.close(4001, "server first");
    else server.send(`echo:${event.data}`);
  });
  if (url.searchParams.has("half"))
    server.addEventListener("close", (event) => server.close(event.code, "replies"));
  if (url.searchParams.has("late"))
    server.addEventListener("close", (event) => {
      setTimeout(() => {
        record(["replying"]);
        server.close(event.code, "late");
      }, 100);
    });
  watch(server, record);
  return new Response(null, { status: 101, webSocket: client });
};

export class Sockets extends DurableObject {
  seen = {};
  fetch(request) {
    const url = new URL(request.url);
    const key = url.pathname.slice(1);
    if (key.startsWith("object-hibernate")) {
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server, [key]);
      return new Response(null, { status: 101, webSocket: client });
    }
    return serve(url, (entry) => (this.seen[key] ??= []).push(entry));
  }
  record(ws, entry) {
    (this.seen[this.ctx.getTags(ws)[0]] ??= []).push(entry);
  }
  webSocketMessage(ws, message) {
    if (message === "first") ws.close(4001, "server first");
    else ws.send(`echo:${message}`);
  }
  // The client's Close gets this reply: workerd answers none for a
  // hibernatable socket (probed: the client waits until the object
  // hibernates, and gets 1006).
  webSocketClose(ws, code, reason, wasClean) {
    this.record(ws, ["close", code, reason, wasClean]);
    if (code !== 4001) ws.close(code, "replies");
  }
  webSocketError(ws, error) {
    this.record(ws, ["error", String(error)]);
  }
  read() {
    return this.seen;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const key = url.pathname.slice(1);
    const object = env.SOCKETS.getByName("sockets");
    // Its own object, so that whatever its sockets do to it leaves the
    // others' record alone.
    const hibernating = env.SOCKETS.getByName("hibernating");
    if (key === "seen") {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return Response.json({
        worker: seen,
        object: await object.read(),
        hibernating: await hibernating.read(),
      });
    }
    if (key.startsWith("object-hibernate")) return hibernating.fetch(request);
    if (key === "pair") {
      // Both ends here: `a` closes first, and `b` replies automatically.
      const [a, b] = Object.values(new WebSocketPair());
      a.accept();
      b.accept();
      watch(a, (entry) => log("pair-a", entry));
      watch(b, (entry) => log("pair-b", entry));
      a.close(4000, "a first");
      await new Promise((resolve) => setTimeout(resolve, 200));
      return Response.json(seen);
    }
    if (key.startsWith("object-")) return object.fetch(request);
    if (key.startsWith("bound-")) {
      // The object's socket, accepted here: this end closes first on
      // `bound-caller-first`, the object's on `bound-object-first`.
      const response = await object.fetch(`http://object/${key}`, { headers: { Upgrade: "websocket" } });
      const socket = response.webSocket;
      socket.accept();
      const events = [];
      watch(socket, (entry) => events.push(entry));
      socket.addEventListener("message", (event) => {
        events.push(event.data);
        socket.close(4000, "caller first");
      });
      const closed = new Promise((resolve) => socket.addEventListener("close", resolve));
      socket.send(key === "bound-caller-first" ? "a" : "first");
      await closed;
      await new Promise((resolve) => setTimeout(resolve, 200));
      return Response.json(events);
    }
    return serve(url, (entry) => log(key, entry));
  },
};
