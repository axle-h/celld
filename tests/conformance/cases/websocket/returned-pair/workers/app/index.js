// A pair whose client end left in a 101 (plan 1.21). Its own request cannot
// accept that end any more, and a later request can neither accept it nor
// use the server end: linking the two inside the isolate would divert the
// first request's frames. One isolate (the case's env), so the later request
// sees the pair.
const pair = {};

const attempt = (use) => {
  try {
    use();
    return "allowed";
  } catch (error) {
    return `${error.name}: ${error.message}`;
  }
};

export default {
  fetch(request) {
    if (new URL(request.url).pathname === "/pair") {
      const [client, server] = Object.values(new WebSocketPair());
      server.accept();
      pair.client = client;
      pair.server = server;
      server.addEventListener("message", (event) => {
        // The same request, after the response left.
        pair.sameRequest = attempt(() => client.accept());
        server.send(`echo:${event.data}`);
        server.close(1000, "done");
      });
      return new Response(null, { status: 101, webSocket: client });
    }
    return Response.json({
      sameRequest: pair.sameRequest,
      laterAccept: attempt(() => pair.client.accept()),
      laterSend: attempt(() => pair.server.send("diverted")),
    });
  },
};
