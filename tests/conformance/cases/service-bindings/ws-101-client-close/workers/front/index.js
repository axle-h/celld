// A client closes a WebSocket that `back` answered through a service binding.
// The reply the client sees is the one the Workers' close listeners chose.
//
// celld answers a client's Close at the connection with an echo before any
// listener runs (plan item 1.17), so the client sees the right code and an
// empty reason. That is the same for a socket the primary returns itself, so
// service-bindings/ws-101 closes from the server side and this case keeps
// the client-initiated close until 1.17 lands.
//
// - /pass: `return env.BACK.fetch(request)`.
// - /accept: the front accepts the socket and relays it through its own
//   pair; a Close goes on to `back`, and `back`'s reply comes back.
export default {
  async fetch(request, env) {
    const response = await env.BACK.fetch(request);
    if (new URL(request.url).pathname === "/pass") return response;
    const back = response.webSocket;
    back.accept();
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    server.addEventListener("message", (event) => back.send(event.data));
    back.addEventListener("message", (event) => server.send(`front:${event.data}`));
    server.addEventListener("close", (event) => back.close(event.code, `front saw ${event.code}`));
    back.addEventListener("close", (event) => {
      server.close(event.code, `front relayed ${event.code} ${event.reason}`);
    });
    return new Response(null, { status: 101, webSocket: client });
  },
};
