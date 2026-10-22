// A socket that one request opened, used by a later request while the first
// still holds it, fails with workerd's cross-request error (plan 1.21), and
// no "stolen" frame reaches the client. One
// isolate (the case's env) so the later request sees the saved socket.
let saved = null;

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/save") {
      const [client, server] = Object.values(new WebSocketPair());
      server.accept();
      saved = server;
      server.addEventListener("message", async () => {
        // A separate request, which runs while this one holds the socket.
        const outcome = await (await fetch(new URL("/use", request.url))).text();
        server.send(outcome);
        server.close(1000, "done");
      });
      return new Response(null, { status: 101, webSocket: client });
    }
    if (url.pathname === "/use") {
      try {
        saved.send("stolen");
        return new Response("sent");
      } catch (error) {
        return new Response(`${error.constructor.name}: ${error.message}`);
      }
    }
    return new Response("not found", { status: 404 });
  },
};
