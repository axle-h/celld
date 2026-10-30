// A WebSocket a Worker accepts without web_socket_compression agrees to no
// extension its client offers, as celld never does
// (websocket/permessage-deflate).
export default {
  fetch(request) {
    if (request.headers.get("upgrade") !== "websocket") return new Response("ready");
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    server.addEventListener("message", (event) => server.send(`echo ${event.data}`));
    return new Response(null, { status: 101, webSocket: client });
  },
};
