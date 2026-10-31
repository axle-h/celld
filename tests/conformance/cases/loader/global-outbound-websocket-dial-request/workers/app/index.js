// What `new WebSocket()` in a Dynamic Worker sends its globalOutbound
// Fetcher, this script's `Outbound` entrypoint, and how its socket opens or
// fails, as in workerd's constructor (plan 1.42): a GET to the URL as http
// or https without its credentials, with `Upgrade: websocket` and the
// subprotocols offered. The 101's subprotocol is the socket's, and null
// without one. Any other answer, a redirect included, fails the socket with
// workerd's TypeError and a 1006 close. A close() before the socket opens
// cancels the dial: the socket reads OPEN and drops what it sends until it
// fails as a dial does, with no open event. A URL with a fragment throws.
// loader/global-outbound-websocket-dial-extensions has the extensions.
import { WorkerEntrypoint } from "cloudflare:workers";

export class Outbound extends WorkerEntrypoint {
  fetch(request) {
    const url = new URL(request.url);
    const headers = [...request.headers].filter(([name]) => name !== "sec-websocket-extensions");
    const seen = { method: request.method, url: request.url, headers, body: request.body, cf: request.cf ?? null };
    if (url.pathname === "/plain") return Response.json(seen);
    if (url.pathname === "/redirect")
      return new Response(null, { status: 302, headers: { location: "http://outbound.test/" } });
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    server.send(JSON.stringify(seen));
    server.addEventListener("close", (event) => server.send(`closed ${event.code} ${event.reason}`));
    const reply = url.pathname === "/protocols" ? { "sec-websocket-protocol": "b" } : {};
    return new Response(null, { status: 101, webSocket: client, headers: reply });
  }
}

const CHILD = `
export default {
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/fragment") {
      const thrown = [];
      for (const url of ["ws://outbound.test/#a", "ws://outbound.test/#"]) {
        try {
          new WebSocket(url);
        } catch (error) {
          thrown.push([error.name, error.message]);
        }
      }
      return Response.json(thrown);
    }
    const socket = path === "/protocols"
      ? new WebSocket("wss://user:secret@outbound.test/protocols?q=1", ["a", "b"])
      : new WebSocket("ws://outbound.test" + path);
    const events = [["constructed", socket.readyState, socket.url, socket.protocol]];
    if (path === "/early") {
      socket.close(4000, "early");
      events.push(["closed early", socket.readyState]);
      try {
        socket.send("dropped");
        events.push("sent");
      } catch (error) {
        events.push(["send threw", error.message]);
      }
    }
    await new Promise((resolve) => {
      setTimeout(() => {
        events.push("waited");
        resolve();
      }, 1000);
      socket.addEventListener("open", () => events.push(["open", socket.readyState, socket.protocol]));
      socket.addEventListener("message", (event) => {
        events.push(JSON.parse(event.data));
        socket.close(1000);
      });
      socket.addEventListener("error", (event) => events.push(["error", event.message, String(event.error)]));
      socket.addEventListener("close", (event) => {
        events.push(["close", event.code, event.reason, event.wasClean, socket.readyState]);
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
      compatibilityDate: "2026-09-04",
      mainModule: "child.js",
      modules: { "child.js": CHILD },
      globalOutbound: ctx.exports.Outbound({}),
    }));
    return child.getEntrypoint().fetch(request);
  },
};
