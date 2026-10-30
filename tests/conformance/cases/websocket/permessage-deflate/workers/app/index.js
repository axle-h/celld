// A WebSocket a Worker accepts agrees to the permessage-deflate its client
// offers under web_socket_compression, on from 2023-08-15, and its frames
// cross compressed. celld never negotiates it, as if the flag were off
// (websocket/permessage-deflate-off).
export default {
  fetch(request) {
    if (request.headers.get("upgrade") !== "websocket") return new Response("ready");
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    server.addEventListener("message", (event) => server.send(`echo ${event.data}`));
    return new Response(null, { status: 101, webSocket: client });
  },
};
