// A WebSocket that a fetch() upgrade to the network returned, used before
// accept() (plan 1.22), as websocket/before-accept uses the others: it reads
// OPEN, and send() and close() throw until it is accepted. The server is the
// runner's upstream, which answers nothing, so nothing arrives after.
const attempt = (use) => {
  try {
    use();
    return "allowed";
  } catch (error) {
    return `${error.name}: ${error.message}`;
  }
};

export default {
  async fetch(request) {
    const target = new URL(request.url).searchParams.get("t");
    const socket = (await fetch(target, { headers: { Upgrade: "websocket" } })).webSocket;
    const seen = { before: socket.readyState };
    seen.send = attempt(() => socket.send("early"));
    seen.close = attempt(() => socket.close(4000, "early"));
    seen.afterClose = socket.readyState;
    const events = [];
    socket.addEventListener("message", (event) => events.push(["message", event.data]));
    socket.addEventListener("close", (event) => events.push(["close", event.code]));
    seen.accept = attempt(() => socket.accept());
    seen.accepted = socket.readyState;
    seen.ping = attempt(() => socket.send("ping"));
    await new Promise((resolve) => setTimeout(resolve, 300));
    seen.events = events;
    seen.closeAfter = attempt(() => socket.close(4001, "late"));
    seen.closing = socket.readyState;
    return Response.json(seen);
  },
};
