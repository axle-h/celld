// A client closes a socket cleanly, and the server end replies
// automatically (web_socket_auto_reply_to_close). workerd then fires an
// `error` event, "Network connection lost.", after the close event: the
// closing handshake ends the socket's pipe while its reply is still being
// reported. It does so run directly too, so wrangler's proxy does not cause
// it (plan 1.42); websocket/connection-lost has the other paths. `/seen`
// answers the events, which live in this isolate (the case's env).
const seen = [];

export default {
  fetch(request) {
    if (new URL(request.url).pathname === "/seen") return Response.json(seen);
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    server.addEventListener("message", (event) => server.send(`echo:${event.data}`));
    server.addEventListener("error", (event) => seen.push(["error", event.message]));
    server.addEventListener("close", (event) => seen.push(["close", event.code, event.wasClean]));
    return new Response(null, { status: 101, webSocket: client });
  },
};
