// A socket a Worker dialed reports the end of its connection as one returned
// to a client does (websocket/connection-lost): replying to the server's
// Close, it fires "Network connection lost." after its close event (plan
// 1.42). `/dial` dials with `new WebSocket()`, `/upgrade` with a fetch()
// upgrade it accepts; the upstream's /ws/close-first sends its Close at
// once. `/early` closes a dialed socket before it connects, which cancels
// the dial: the socket fails as a dial does.
const record = async (socket, opened) => {
  const events = [];
  socket.addEventListener("open", () => events.push("open"));
  socket.addEventListener("message", (event) => events.push(event.data));
  socket.addEventListener("error", (event) => events.push(["error", event.message]));
  await new Promise((resolve) => {
    socket.addEventListener("close", (event) => {
      events.push(["close", event.code, event.reason, event.wasClean, socket.readyState]);
      setTimeout(resolve, 200);
    });
    opened?.(events);
  });
  return events;
};

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const target = url.searchParams.get("t");
    if (url.pathname === "/dial") return Response.json(await record(new WebSocket(target)));
    if (url.pathname === "/early") {
      const socket = new WebSocket(target);
      return Response.json(await record(socket, (events) => {
        socket.close(4000, "early");
        events.push(["closed early", socket.readyState]);
      }));
    }
    const response = await fetch(target, { headers: { Upgrade: "websocket" } });
    response.webSocket.accept();
    return Response.json(await record(response.webSocket));
  },
};
