// `new WebSocket()` through a globalOutbound Fetcher offers
// permessage-deflate under web_socket_compression, and the Fetcher's 101
// agrees to the offer, so the socket's `extensions` is the offer. celld
// negotiates no extension (plan 1.64), so it offers none and reports ""
// (plan 1.70).
import { WorkerEntrypoint } from "cloudflare:workers";

export class Outbound extends WorkerEntrypoint {
  fetch(request) {
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    server.send(String(request.headers.get("sec-websocket-extensions")));
    return new Response(null, { status: 101, webSocket: client });
  }
}

const CHILD = `
export default {
  async fetch() {
    const socket = new WebSocket("ws://outbound.test/");
    const offered = await new Promise((resolve) => socket.addEventListener("message", (event) => resolve(event.data)));
    const agreed = socket.extensions;
    socket.close(1000);
    return Response.json({ offered, agreed });
  },
};
`;

export default {
  fetch(request, env, ctx) {
    const child = env.LOADER.get("child", () => ({
      compatibilityDate: "2026-09-04",
      mainModule: "child.js",
      modules: { "child.js": CHILD },
      globalOutbound: ctx.exports.Outbound({}),
    }));
    return child.getEntrypoint().fetch(request);
  },
};
