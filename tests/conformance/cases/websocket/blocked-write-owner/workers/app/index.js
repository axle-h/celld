// A stateless Worker dials three sockets to a server that never reads,
// sends 30 MiB on each and returns (plan 1.22). The writes never finish.
// They stay charged to the isolate's memory budget while the request runs,
// and once the request has ended they are abandoned with their connections
// after a second, which gives the charge back. So the next request can send
// as much again: no socket of it closes for the budget. `/dial` answers the
// close events each socket saw within 300 ms of its send.
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/warm") return new Response("warm");
    const big = "x".repeat(30 * 1024 * 1024);
    const closes = [];
    for (let socket = 0; socket < 3; socket++) {
      const ws = new WebSocket(url.searchParams.get("t"));
      await new Promise((resolve, reject) => {
        ws.addEventListener("open", resolve);
        ws.addEventListener("error", reject);
      });
      ws.addEventListener("close", (event) => closes.push([socket, event.code, event.reason]));
      ws.send(big);
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    return Response.json(closes);
  },
};
