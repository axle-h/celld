// Floods the server end it returns with 1700 messages of 60000 bytes before
// returning it, and logs what that end sees. `/seen` answers the log, which
// lives in this isolate (the case's env).
const seen = [];

export default {
  fetch(request) {
    if (new URL(request.url).pathname === "/seen") return Response.json(seen);
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    server.addEventListener("error", (event) => seen.push(["error", event.message]));
    server.addEventListener("close", (event) => seen.push(["close", event.code, event.reason, event.wasClean]));
    const response = new Response(null, { status: 101, webSocket: client });
    const message = "x".repeat(60000);
    queueMicrotask(() => {
      for (let sent = 0; sent < 1700; sent++) server.send(message);
      seen.push(["flooded", server.readyState]);
    });
    return response;
  },
};
