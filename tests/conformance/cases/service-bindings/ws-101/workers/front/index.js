// A WebSocket upgrade answered by another script's stateless isolate and
// returned through a service binding (trial failure 5).
//
// The first path segment picks the route, and the rest of the path goes to
// the server end (see ../../shared.js):
// - /pass/...: `return env.BACK.fetch(request)`, the router's shape.
// - /rebuild/...: the response rebuilt with `new Response(r.body, r)`, as
//   Hono does after middleware.
// - /double/...: through `mid`, which passes it on to `back`: two hops.
// - /dynamic/...: a Dynamic Worker's entrypoint returns the pair.
// - /accept/...: the front accepts the socket and relays it (see `relay`).
// - /object/...: a Durable Object returns the socket `back` returned to it.
// - /object-accept/...: that Durable Object accepts and relays it instead.
// - /rewrite/...: HTMLRewriter.transform() over the 101.
// - /object-return-accepted: that Durable Object accepts the socket and then
//   returns it.
// - /rpc-response: that Durable Object returns the 101 over RPC.
// - /bare-101: a 101 with no WebSocket.
//
// Every step closes from the server side, `back` or the relay.
// service-bindings/ws-101-client-close has the closes a client starts.
import { DurableObject } from "cloudflare:workers";
import { serve } from "../../shared.js";

const DYNAMIC_SOURCE = `${serve.toString()}
export default { fetch: (request) => serve(request, "dynamic") };
`;

function dynamicWorker(env) {
  return env.LOADER.get("ws-101", () => ({
    compatibilityDate: "2026-01-01",
    mainModule: "index.js",
    modules: { "index.js": DYNAMIC_SOURCE },
    globalOutbound: null,
  }));
}

// Accept the socket in `response` and relay it to a client through a pair of
// this isolate's own, so `name` sees every frame in both directions.
// - Frames from `back` reach the client as `<name>:<frame>`, or
//   `<name>:len:<length>` for a frame longer than 64 characters.
// - A client frame `up:<n>x<count>` becomes `count` frames of `n` characters
//   to `back`, and `relay-close:<code>` makes `name` close `back` with that
//   code. Any other client frame goes to `back` unchanged.
// - A Close from either side closes the other with the same code, and every
//   Close is answered by a listener: before 2026-04-07 nothing replies
//   automatically (web_socket_auto_reply_to_close).
// The 101 carries `back`'s headers, so a subprotocol `back` selected reaches
// the client.
function relay(response, name) {
  const back = response.webSocket;
  if (response.status !== 101 || back === null) return response;
  back.accept();
  const [client, server] = Object.values(new WebSocketPair());
  server.accept();
  // Each side's Close is answered once. A client's Close goes on to `back`,
  // and the client's reply waits for `back`'s, so the reason the client sees
  // shows the whole chain.
  let backClosed = false;
  let serverClosed = false;
  server.addEventListener("message", (event) => {
    const data = String(event.data);
    if (data.startsWith("relay-close:")) {
      backClosed = true;
      back.close(Number(data.slice(12)), `${name} closed`);
    } else if (data.startsWith("up:")) {
      const [length, count] = data.slice(3).split("x").map(Number);
      for (let sent = 0; sent < count; sent++) back.send("y".repeat(length));
    } else {
      back.send(data);
    }
  });
  back.addEventListener("message", (event) => {
    const data = String(event.data);
    server.send(`${name}:${data.length > 64 ? `len:${data.length}` : data}`);
  });
  const reason = (text) => text.slice(0, 120);
  server.addEventListener("close", (event) => {
    if (!backClosed) {
      backClosed = true;
      back.close(event.code, `${name} saw ${event.code}`);
    } else if (!serverClosed) {
      serverClosed = true;
      server.close(event.code, reason(`${name} saw ${event.code}`));
    }
  });
  back.addEventListener("close", (event) => {
    if (!backClosed) {
      backClosed = true;
      back.close(event.code, `${name} saw ${event.code}`);
    }
    if (!serverClosed) {
      serverClosed = true;
      server.close(event.code, reason(`${name} relayed ${event.code} ${event.reason}`));
    }
  });
  return new Response(null, { status: 101, webSocket: client, headers: response.headers });
}

export class Relay extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url);
    const [, mode] = url.pathname.split("/");
    if (mode === "accept" || mode === "return-accepted") {
      url.pathname = url.pathname.slice(mode.length + 1);
    }
    const response = await this.env.BACK.fetch(new Request(url, request));
    if (mode === "accept") return relay(response, "object");
    if (mode === "return-accepted") response.webSocket.accept();
    return response;
  }

  // A Response that carries a WebSocket, returned over RPC.
  async socketResponse() {
    return this.env.BACK.fetch("http://back.test/echo", { headers: { Upgrade: "websocket" } });
  }
}

const describeError = (error) => new Response(`${error.name}: ${error.message}`, { status: 500 });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const [, route, ...rest] = url.pathname.split("/");
    url.pathname = `/${rest.join("/")}`;
    const forwarded = new Request(url, request);
    switch (route) {
      case "pass":
        return env.BACK.fetch(forwarded);
      case "rebuild": {
        const response = await env.BACK.fetch(forwarded);
        return new Response(response.body, response);
      }
      case "double":
        return env.MID.fetch(forwarded);
      case "dynamic":
        return dynamicWorker(env).getEntrypoint().fetch(forwarded);
      case "accept":
        return relay(await env.BACK.fetch(forwarded), "front");
      case "object":
        return env.RELAY.getByName("relay").fetch(forwarded);
      case "object-accept":
        url.pathname = `/accept${url.pathname}`;
        return env.RELAY.getByName("relay").fetch(new Request(url, request));
      case "rewrite":
        // HTMLRewriter rewrites the body and keeps the socket.
        return new HTMLRewriter().transform(await env.BACK.fetch(forwarded));
      case "object-return-accepted":
        // The object accepts the socket and then returns it.
        try {
          const response = await env.RELAY.getByName("relay").fetch(
            new Request("http://relay.test/return-accepted/echo", { headers: { Upgrade: "websocket" } }),
          );
          return new Response(`status ${response.status}`);
        } catch (error) {
          return describeError(error);
        }
      case "object-return-accepted-pass":
        url.pathname = `/return-accepted${url.pathname}`;
        return env.RELAY.getByName("relay").fetch(new Request(url, request));
      case "rpc-response":
        try {
          const response = await env.RELAY.getByName("relay").socketResponse();
          return new Response(`status ${response.status}`);
        } catch (error) {
          return describeError(error);
        }
      case "bare-101":
        try {
          return new Response(null, { status: 101 });
        } catch (error) {
          return new Response(`${error.name}: ${error.message}`, { status: 500 });
        }
      default:
        return new Response("not found", { status: 404 });
    }
  },
};
