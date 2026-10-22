// A socket that an ended request opened, used by a later request, fails
// with the cross-request error before its state is consulted, as in workerd
// (plan 1.21). One isolate (the case's env), so the later request sees it.
let saved = null;

export default {
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/save") {
      const [client, server] = Object.values(new WebSocketPair());
      server.accept();
      saved = server;
      server.addEventListener("message", (event) => {
        server.send(`echo:${event.data}`);
        server.close(1000, "done");
      });
      return new Response(null, { status: 101, webSocket: client });
    }
    const outcome = {};
    for (const [name, use] of Object.entries({
      send: () => saved.send("stolen"),
      close: () => saved.close(1000, "stolen"),
      accept: () => saved.accept(),
    })) {
      try {
        use();
        outcome[name] = "allowed";
      } catch (error) {
        outcome[name] = `${error.name}: ${error.message}`;
      }
    }
    return Response.json(outcome);
  },
};
