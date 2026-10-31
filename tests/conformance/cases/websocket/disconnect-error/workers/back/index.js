// The server end of `/unanswered`: it closes first, and logs what it sees.
const seen = [];

export default {
  fetch(request) {
    if (new URL(request.url).pathname === "/seen") return Response.json(seen);
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    server.addEventListener("message", () => server.close(4001, "back first"));
    server.addEventListener("error", (event) => seen.push(["error", event.message]));
    server.addEventListener("close", (event) => seen.push(["close", event.code, event.reason, event.wasClean]));
    return new Response(null, { status: 101, webSocket: client });
  },
};
