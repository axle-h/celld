// A Dynamic Worker whose globalOutbound is a Fetcher fetches a WebSocket
// upgrade (plan 1.22). The Fetcher, this script's `Outbound` entrypoint,
// answers with a 101 and the client end of a pair it accepted, which echoes
// each frame and closes with 4000 on `close`. The Dynamic Worker either
// returns that 101 to the client (`/pass`), or accepts the socket and relays
// it (`/accept`). `/plain` fetches without asking to upgrade.
// loader/global-outbound-websocket-dial dials with `new WebSocket()`.
import { WorkerEntrypoint } from "cloudflare:workers";

export class Outbound extends WorkerEntrypoint {
  fetch(request) {
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    server.addEventListener("message", (event) => {
      if (event.data === "close") server.close(4000, "outbound closes");
      else server.send(`outbound:${event.data}`);
    });
    server.addEventListener("close", (event) => server.close(event.code, "outbound replies"));
    const upgrade = request.headers.get("Upgrade") ?? "none";
    return new Response(null, { status: 101, webSocket: client, headers: { "x-upgrade": upgrade } });
  }
}

const CHILD = `
export default {
  async fetch(request) {
    const mode = new URL(request.url).pathname.slice(1);
    const describe = (error) => new Response(error.name + ": " + error.message, { status: 500 });
    let response;
    try {
      response = await fetch("http://outbound.test/", mode === "plain" ? {} : { headers: { Upgrade: "websocket" } });
    } catch (error) {
      return describe(error);
    }
    if (mode !== "accept") return response;
    const back = response.webSocket;
    back.accept();
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    server.addEventListener("message", (event) => back.send(event.data));
    back.addEventListener("message", (event) => server.send("child:" + event.data));
    back.addEventListener("close", (event) => {
      back.close(event.code, "child replies");
      server.close(event.code, "child relayed " + event.reason);
    });
    server.addEventListener("close", (event) => server.close(event.code, "child saw"));
    return new Response(null, { status: 101, webSocket: client, headers: response.headers });
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
