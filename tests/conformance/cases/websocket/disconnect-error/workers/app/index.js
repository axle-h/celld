// workerd reports a connection that ended without a Close only as a close
// event, 1006, and fires no error event. celld fires an error first,
// "WebSocket closed abnormally: ..." (plan 1.70).
// - `/drop`: the client ends the connection after one message.
// - `/unanswered`: `back`'s server end closes first, and this script, under
//   a date before web_socket_auto_reply_to_close, does not reply before its
//   request ends.
// `/seen` answers what each server end saw, which lives in each isolate.
const seen = [];

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === "/seen") {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return Response.json({ drop: seen, unanswered: await (await env.BACK.fetch("http://back/seen")).json() });
    }
    if (path === "/unanswered") {
      const response = await env.BACK.fetch("http://back/", { headers: { Upgrade: "websocket" } });
      const socket = response.webSocket;
      socket.accept();
      const closed = new Promise((resolve) => socket.addEventListener("close", resolve));
      socket.send("close first");
      const event = await closed;
      return Response.json([event.code, event.reason]);
    }
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    server.addEventListener("error", (event) => seen.push(["error", event.message]));
    server.addEventListener("close", (event) => seen.push(["close", event.code, event.reason, event.wasClean]));
    return new Response(null, { status: 101, webSocket: client });
  },
};
