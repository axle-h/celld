// connect() is the operator-network tool, so the egress policy of fetch()
// doesn't apply to it: it reaches the runner's upstream server on loopback
// with no allowlist entry. The node's internal listener is the exception, by
// its address or through the unspecified address, even with
// CELLD_FETCH_PRIVATE_ALLOW naming it. `localhost` resolves to 127.0.0.1,
// which is refused, and to ::1, where nothing listens, so the transcript
// records only that it doesn't reach the listener.
import { connect } from "cloudflare:sockets";

async function get(hostname, port) {
  const target = `${hostname}:${port}`;
  try {
    const socket = connect({ hostname, port });
    await socket.opened;
    const writer = socket.writable.getWriter();
    await writer.write(new TextEncoder().encode("GET / HTTP/1.0\r\nHost: x\r\n\r\n"));
    const reader = socket.readable.getReader();
    let text = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    await socket.close();
    return { target, status: text.split("\r\n")[0], body: text.split("\r\n\r\n")[1] };
  } catch (error) {
    return { target, error: error.name, message: error.message };
  }
}

export default {
  async fetch(request) {
    const params = new URL(request.url).searchParams;
    const internal = params.get("internal");
    return Response.json([
      await get("127.0.0.1", params.get("upstream")),
      await get("127.0.0.1", internal),
      { target: "localhost", reached: "status" in (await get("localhost", internal)) },
      await get("0.0.0.0", internal),
    ]);
  },
};
