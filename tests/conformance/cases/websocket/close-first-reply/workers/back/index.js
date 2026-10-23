// The server end the front relays. Each frame is echoed as `back:<frame>`,
// except `close-first:<code>`, which makes this end close first. Its close
// event is logged under the path's tag, and a Close it did not start is
// answered with the same code. `/seen` answers the log, which lives in this
// isolate (the case's env).
const seen = {};

export default {
  fetch(request) {
    const tag = new URL(request.url).pathname.slice(1);
    if (tag === "seen") return Response.json(seen);
    const log = (...entry) => (seen[tag] ??= []).push(entry);
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    let closed = false;
    server.addEventListener("message", (event) => {
      const data = String(event.data);
      if (data.startsWith("close-first:")) {
        closed = true;
        server.close(Number(data.slice(12)), "back closes");
        log("back after close()", server.readyState);
      } else {
        server.send(`back:${data}`);
      }
    });
    server.addEventListener("close", (event) => {
      log("back close", event.code, event.reason, event.wasClean, server.readyState);
      if (!closed) server.close(event.code, "back replies");
    });
    return new Response(null, { status: 101, webSocket: client });
  },
};
