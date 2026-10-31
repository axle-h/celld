// The events of a socket that a stateless Worker returned share its
// request's CPU limit, as workerd's `topUpActor` tops up only a Durable
// Object's: each of the 200 messages spins for a few milliseconds, well
// under the 200 ms limit, and together they pass it. The request then ends
// as any request past its limit does, and its client's connection ends
// without a Close (1006). The node goes on answering.

// About 10 ms of CPU; `Date.now()` does not advance while a handler runs.
const spin = () => {
  let x = 0;
  for (let i = 0; i < 3e6; i++) x = (x * 31 + i) | 0;
  return x;
};

export default {
  async fetch(request) {
    if (request.headers.get("upgrade") !== "websocket") return new Response("answering");
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    let first = true;
    server.addEventListener("message", () => {
      if (first) server.send("first");
      first = false;
      globalThis.sink = spin();
    });
    return new Response(null, { status: 101, webSocket: client });
  },
};
