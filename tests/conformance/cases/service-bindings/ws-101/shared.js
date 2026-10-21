// The server end both `back` and the Dynamic Worker in `front` run. Shared
// source, so a difference between the two paths is the path's, not the
// handler's.
//
// The path's last segment picks the behaviour:
// - `echo`: answers each frame with `<name>:<frame>`.
// - `greet`: sends a greeting before the client sends anything, then echoes.
// - `protocol`: selects the first subprotocol the client offered.
// A frame `close:<code>` makes the server close with that code, and a frame
// `later:<text>` makes it echo and close with 4100 after a timer; a frame
// `big:<n>x<count>` is answered with `count` frames of `n` characters, and a
// frame longer than 64 characters is answered with its length, so the
// transcript stays small.
export function serve(request, name) {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return new Response(`${name}: websocket upgrade required`, { status: 426 });
  }
  const mode = new URL(request.url).pathname.split("/").pop();
  const [client, server] = Object.values(new WebSocketPair());
  server.accept();
  server.addEventListener("message", (event) => {
    const data = String(event.data);
    if (data.startsWith("close:")) {
      server.close(Number(data.slice(6)), `${name} closed`);
    } else if (data.startsWith("later:")) {
      // After the 101 has gone and this event has nothing else to do: the
      // socket alone keeps it running.
      setTimeout(() => {
        server.send(`${name}:${data}`);
        server.close(4100, `${name} closed later`);
      }, 100);
    } else if (data.startsWith("big:")) {
      const [length, count] = data.slice(4).split("x").map(Number);
      for (let sent = 0; sent < count; sent++) server.send("x".repeat(length));
    } else if (data.length > 64) {
      server.send(`${name}:len:${data.length}`);
    } else {
      server.send(`${name}:${data}`);
    }
  });
  server.addEventListener("close", (event) => {
    server.close(event.code, `${name} saw ${event.code} ${event.reason}`.trim());
  });
  if (mode === "greet") server.send(`${name}:hello`);
  const headers = new Headers();
  if (mode === "protocol") {
    const offered = request.headers.get("Sec-WebSocket-Protocol") ?? "";
    headers.set("Sec-WebSocket-Protocol", offered.split(",")[0].trim());
  }
  return new Response(null, { status: 101, webSocket: client, headers });
}
