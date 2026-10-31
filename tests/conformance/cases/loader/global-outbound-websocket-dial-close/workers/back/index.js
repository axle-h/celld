// The server end for the `other-*` requests of the front: as `serve` there.
// `/seen` answers what each end saw, which lives in this isolate.
const seen = {};

export default {
  fetch(request) {
    const key = new URL(request.url).pathname.slice(1);
    if (key === "seen") return Response.json(seen);
    const log = (entry) => (seen[key] ??= []).push(entry);
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    server.addEventListener("message", (event) => {
      if (key.includes("server-first")) server.close(4001, "server first");
      else server.send(`server:${event.data}`);
    });
    server.addEventListener("error", (event) => log(["error", event.message]));
    server.addEventListener("close", (event) => log(["close", event.code, event.reason, event.wasClean]));
    return new Response(null, { status: 101, webSocket: client });
  },
};
