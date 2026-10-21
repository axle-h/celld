// The server end: echoes each frame, and answers a Close with the same code
// and a reason that names what it saw.
export default {
  fetch() {
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    server.addEventListener("message", (event) => server.send(`back:${event.data}`));
    server.addEventListener("close", (event) => {
      server.close(event.code, `back saw ${event.code} ${event.reason}`.trim());
    });
    return new Response(null, { status: 101, webSocket: client });
  },
};
