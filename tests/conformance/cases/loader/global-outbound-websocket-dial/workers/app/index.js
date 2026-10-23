// A Dynamic Worker whose globalOutbound is a Fetcher dials with
// `new WebSocket()`. workerd sends the upgrade to the Fetcher, this script's
// `Outbound` entrypoint, whose 101 opens the socket. celld refuses the dial
// (plan 1.42); loader/global-outbound-websocket has the fetch() upgrade.
import { WorkerEntrypoint } from "cloudflare:workers";

export class Outbound extends WorkerEntrypoint {
  fetch() {
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    server.addEventListener("message", (event) => server.send(`outbound:${event.data}`));
    server.addEventListener("close", (event) => server.close(event.code, "outbound replies"));
    return new Response(null, { status: 101, webSocket: client });
  }
}

const CHILD = `
export default {
  async fetch() {
    let socket;
    try {
      socket = new WebSocket("ws://outbound.test/");
    } catch (error) {
      return new Response(error.name + ": " + error.message, { status: 500 });
    }
    const events = [];
    await new Promise((resolve) => {
      socket.addEventListener("open", () => {
        events.push("open");
        socket.send("a");
      });
      socket.addEventListener("message", (event) => {
        events.push(event.data);
        socket.close(4000, "child closes");
      });
      socket.addEventListener("error", () => events.push("error"));
      socket.addEventListener("close", (event) => {
        events.push("close " + event.code + " " + event.reason);
        resolve();
      });
    });
    return Response.json(events);
  },
};
`;

export default {
  fetch(request, env, ctx) {
    const child = env.LOADER.get("child", () => ({
      compatibilityDate: "2026-01-01",
      mainModule: "child.js",
      modules: { "child.js": CHILD },
      globalOutbound: ctx.exports.Outbound({}),
    }));
    return child.getEntrypoint().fetch(request);
  },
};
