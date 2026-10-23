// Echoes each frame as `back:<frame>`, and answers a Close with the same code.
export default {
  fetch() {
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    server.addEventListener("message", (event) => server.send(`back:${event.data}`));
    server.addEventListener("close", (event) => server.close(event.code, `back saw ${event.code}`));
    return new Response(null, { status: 101, webSocket: client });
  },
};
