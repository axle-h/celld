// A request that only its open WebSocket keeps holds no admission slot
// (CELLD_MAX_REQUESTS), up to CELLD_MAX_SOCKET_REQUESTS such requests on the
// node; one past that keeps its slot. With both at 2, /hold holds one slot
// itself, opens two idle sockets to /echo, and a plain request still gets
// in. A third socket keeps its slot, and the next plain request is refused.

// Resolves with the socket once it has answered one message.
const open = (url) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener("open", () => ws.send("ping"));
    ws.addEventListener("message", () => resolve(ws), { once: true });
    ws.addEventListener("error", (event) => reject(new Error(`socket error: ${event.message}`)));
  });

const closed = (ws) =>
  new Promise((resolve) => {
    ws.addEventListener("close", (event) => resolve(event.code));
    ws.close(1000, "done");
  });

const plain = async (origin) => {
  const response = await fetch(new URL("/plain", origin));
  return `${response.status} ${await response.text()}`;
};

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/echo") {
      const [client, server] = Object.values(new WebSocketPair());
      server.accept();
      server.addEventListener("message", (event) => server.send(`echo:${event.data}`));
      server.addEventListener("close", (event) => server.close(event.code, "echo closed"));
      return new Response(null, { status: 101, webSocket: client });
    }
    if (url.pathname === "/plain") return new Response("plain");
    if (url.pathname === "/hold") {
      const target = new URL("/echo", request.url).href.replace(/^http/, "ws");
      const sockets = [];
      const report = {};
      try {
        sockets.push(await open(target), await open(target));
        report.twoSockets = await plain(request.url);
        sockets.push(await open(target));
        report.threeSockets = await plain(request.url);
      } catch (error) {
        report.error = String(error.message);
      }
      report.closed = await Promise.all(sockets.map(closed));
      return Response.json(report);
    }
    return new Response("not found", { status: 404 });
  },
};
