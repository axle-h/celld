// The `waitUntil` work of a socket's events goes as it settles, as workerd's
// TaskSet drops a settled task, though the request lives on for the socket.
// Each of 640 messages registers a settled promise of a 256 KiB value: held
// for the socket's life, they would pass the isolate's 128 MiB heap limit
// near the 512th, and the isolate would be retired with the socket. /handler
// does the same within its handler, before it answers.

const big = () => new Uint8Array(256 * 1024).fill(1);

export default {
  async fetch(request, env, ctx) {
    if (new URL(request.url).pathname === "/handler") {
      let count = 0;
      for (; count < 640; count++) {
        ctx.waitUntil(Promise.resolve(big()));
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      return new Response(`survived ${count}`);
    }
    if (request.headers.get("upgrade") !== "websocket") return new Response("answering");
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    let count = 0;
    server.addEventListener("message", () => {
      ctx.waitUntil(Promise.resolve(big()));
      if (++count === 640) server.send(`survived ${count}`);
    });
    server.addEventListener("close", (event) => server.close(event.code, "done"));
    return new Response(null, { status: 101, webSocket: client });
  },
};
