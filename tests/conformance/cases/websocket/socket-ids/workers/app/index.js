// Legitimate socket paths whose ids the host now allocates as it registers
// them (plan 1.21): a Worker accepting a Durable Object's socket from
// `stub.fetch`, a regular Durable Object accept, and the hibernation API
// across events and a restart. websocket/socket-ids-dial covers the dials,
// which workerd under the test harness cannot make to its own origin.
import { DurableObject } from "cloudflare:workers";

// Resolves with the first message, after sending `first` once open.
const exchange = (ws, first) =>
  new Promise((resolve, reject) => {
    ws.addEventListener("message", (event) => resolve(String(event.data)));
    ws.addEventListener("error", () => reject(new Error("socket error")));
    ws.addEventListener("close", (event) => reject(new Error(`closed ${event.code}`)));
    if (ws.readyState === WebSocket.OPEN) ws.send(first);
    else ws.addEventListener("open", () => ws.send(first));
  });

const echoUrl = (request) => new URL("/echo", request.url).href.replace(/^http/, "ws");

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/regular") {
      const [client, server] = Object.values(new WebSocketPair());
      server.accept();
      server.addEventListener("message", (event) => server.send(`regular:${event.data}`));
      server.addEventListener("close", (event) => server.close(event.code, "regular closed"));
      return new Response(null, { status: 101, webSocket: client });
    }
    if (url.pathname === "/hibernatable") {
      const [client, server] = Object.values(new WebSocketPair());
      const tag = url.searchParams.get("tag");
      this.ctx.acceptWebSocket(server, [tag, "shared"]);
      server.serializeAttachment({ tag, n: 1, when: new Date(0) });
      return new Response(null, { status: 101, webSocket: client });
    }
    if (url.pathname === "/object-dial") {
      // The Durable Object's own outbound socket, used again from a later
      // event of the same object.
      this.dialed = new WebSocket(url.searchParams.get("target"));
      return new Response(`object-dial:${await exchange(this.dialed, "from-object")}`);
    }
    if (url.pathname === "/object-dial-again") {
      const reply = await exchange(this.dialed, "again");
      this.dialed.close(1000, "done");
      return new Response(`object-dial-again:${reply}`);
    }
    return new Response("not found", { status: 404 });
  }

  webSocketMessage(ws, message) {
    const { tag } = ws.deserializeAttachment();
    if (message === "list") {
      ws.send(JSON.stringify({
        tagged: this.ctx.getWebSockets(tag).length,
        untagged: this.ctx.getWebSockets("nobody").length,
        tags: this.ctx.getTags(this.ctx.getWebSockets(tag)[0]),
      }));
    } else if (message === "read") {
      ws.send(`read:${JSON.stringify(ws.deserializeAttachment())}`);
    } else if (message === "attach") {
      ws.serializeAttachment({ tag, n: 2 });
      ws.send("attached");
    } else if (message === "stamp") {
      ws.send(`stamped:${this.ctx.getWebSocketAutoResponseTimestamp(ws) !== null}`);
    } else {
      ws.send(`unexpected:${message}`);
    }
  }

  webSocketClose(ws, code) {
    ws.close(code, "hibernatable closed");
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const room = env.ROOM.getByName("room");
    if (url.pathname === "/echo") {
      const [client, server] = Object.values(new WebSocketPair());
      server.accept();
      server.addEventListener("message", (event) => server.send(`echo:${event.data}`));
      server.addEventListener("close", (event) => server.close(event.code, "echo closed"));
      return new Response(null, { status: 101, webSocket: client });
    }
    if (url.pathname === "/dial") {
      const ws = new WebSocket(echoUrl(request));
      const reply = await exchange(ws, "from-dial");
      ws.close(1000, "done");
      return new Response(`dial:${reply}`);
    }
    if (url.pathname === "/upgrade") {
      const response = await fetch(new URL("/echo", request.url), {
        headers: { Upgrade: "websocket" },
      });
      const ws = response.webSocket;
      ws.accept();
      const reply = await exchange(ws, "from-upgrade");
      ws.close(1000, "done");
      return new Response(`upgrade:${response.status}:${reply}`);
    }
    if (url.pathname === "/bind") {
      const response = await room.fetch("http://room/regular", {
        headers: { Upgrade: "websocket" },
      });
      const ws = response.webSocket;
      ws.accept();
      const reply = await exchange(ws, "from-bind");
      ws.close(1000, "done");
      return new Response(`bind:${response.status}:${reply}`);
    }
    if (url.pathname === "/object-dial") {
      const target = encodeURIComponent(echoUrl(request));
      const first = await (await room.fetch(`http://room/object-dial?target=${target}`)).text();
      const again = await (await room.fetch("http://room/object-dial-again")).text();
      return new Response(`${first} ${again}`);
    }
    if (url.pathname === "/regular" || url.pathname === "/hibernatable") {
      return room.fetch(request);
    }
    return new Response("not found", { status: 404 });
  },
};
