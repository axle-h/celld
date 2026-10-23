// A client sends a few messages and then ends its connection without a
// Close. The server end, a stateless Worker's, reads every message and then
// closes abnormally (1006): the messages still queued for it when the
// connection ended are not lost (plan 1.22). `/seen` answers what it saw,
// which lives in this isolate (the case's env).
const seen = [];

export default {
  fetch(request) {
    if (new URL(request.url).pathname === "/seen") return Response.json(seen);
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    server.addEventListener("message", (event) => seen.push(["message", event.data]));
    server.addEventListener("close", (event) => seen.push(["close", event.code, event.reason, event.wasClean]));
    return new Response(null, { status: 101, webSocket: client });
  },
};
