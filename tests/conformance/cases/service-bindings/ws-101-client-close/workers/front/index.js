// A client closes a WebSocket that `back` answered through a service binding.
// The reply the client sees is the one the Workers' close listeners chose:
// before 2026-04-07 no socket replies automatically
// (web_socket_auto_reply_to_close).
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
