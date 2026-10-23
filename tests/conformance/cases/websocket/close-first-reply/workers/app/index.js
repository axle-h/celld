// A WebSocket end that closes first is CLOSING until its peer's Close
// arrives, and its close event fires with that reply (plan 1.22). Each path
// closes first from one kind of end, and logs the end's readyState after
// close() and its close event:
// - /stateless: the server end a stateless Worker returned to the client.
// - /hibernatable: a Durable Object's socket taken with acceptWebSocket().
// - /relay-handoff-close: the front's end of a socket a service binding
//   returned, which the front accepted; `back` replies.
// - /handoff-close: `back`'s end of that socket; the front replies.
// - /relay-object-close and /object-close: the same through a Durable
//   Object's `stub.fetch`.
// Before 2026-04-07 nothing replies automatically, so every reply below is a
// listener's (web_socket_auto_reply_to_close). A stateless request's entries
// live in its isolate (the case's env), and a Durable Object's in `Log`.
import { DurableObject } from "cloudflare:workers";

export class Log extends DurableObject {
  entries = {};
  push(tag, entry) {
    (this.entries[tag] ??= []).push(entry);
  }
  read() {
    return this.entries;
  }
}

const seen = {};
const logger = (env, tag) => (...entry) => {
  if (env === null) (seen[tag] ??= []).push(entry);
  else env.LOG.getByName("log").push(tag, entry);
};

// A server end that closes first with `code` when the client sends a frame.
function closingServer(log, code) {
  const [client, server] = Object.values(new WebSocketPair());
  server.accept();
  server.addEventListener("message", () => {
    server.close(code, "server closes");
    log("after close()", server.readyState);
  });
  server.addEventListener("close", (event) => {
    log("close", event.code, event.reason, event.wasClean, server.readyState);
  });
  return new Response(null, { status: 101, webSocket: client });
}

export class Sockets extends DurableObject {
  fetch(request) {
    const tag = new URL(request.url).pathname.slice(1);
    const log = logger(this.env, tag);
    if (tag === "hibernatable") {
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }
    // The object's end for the front to accept: it echoes, closes first on
    // `close-first:<code>`, and answers a Close it did not start.
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    let closed = false;
    server.addEventListener("message", (event) => {
      const data = String(event.data);
      if (data.startsWith("close-first:")) {
        closed = true;
        server.close(Number(data.slice(12)), "object closes");
        log("object after close()", server.readyState);
      } else {
        server.send(`object:${data}`);
      }
    });
    server.addEventListener("close", (event) => {
      log("object close", event.code, event.reason, event.wasClean, server.readyState);
      if (!closed) server.close(event.code, "object replies");
    });
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws) {
    ws.close(4042, "server closes");
    logger(this.env, "hibernatable")("after close()", ws.readyState);
  }

  webSocketClose(ws, code, reason, wasClean) {
    logger(this.env, "hibernatable")("close", code, reason, wasClean, ws.readyState);
  }
}

// Accept the socket `response` carries and relay it to the client.
// `closeFirst` names the end that closes first when the client sends a
// frame: "front" closes the accepted socket with 4043, and "peer" asks the
// other end to close with 4044. Either way the client is closed with the
// accepted socket's close event's code once that event fires.
function relay(response, log, closeFirst) {
  const peer = response.webSocket;
  peer.accept();
  const [client, server] = Object.values(new WebSocketPair());
  server.accept();
  let closed = false;
  server.addEventListener("message", () => {
    if (closeFirst === "front") {
      closed = true;
      peer.close(4043, "front closes");
      log("front after close()", peer.readyState);
    } else {
      peer.send("close-first:4044");
    }
  });
  peer.addEventListener("close", (event) => {
    log("front close", event.code, event.reason, event.wasClean, peer.readyState);
    if (!closed) peer.close(event.code, "front replies");
    server.close(event.code, "relayed");
  });
  return new Response(null, { status: 101, webSocket: client });
}

const upgrade = { headers: { Upgrade: "websocket" } };

export default {
  async fetch(request, env) {
    const tag = new URL(request.url).pathname.slice(1);
    const log = logger(null, tag);
    switch (tag) {
      case "stateless":
        return closingServer(log, 4041);
      case "hibernatable":
        return env.SOCKETS.getByName("sockets").fetch(request);
      case "relay-handoff-close":
      case "handoff-close":
        return relay(
          await env.BACK.fetch(`http://back/${tag}`, upgrade),
          log,
          tag === "handoff-close" ? "peer" : "front",
        );
      case "relay-object-close":
      case "object-close":
        return relay(
          await env.SOCKETS.getByName("sockets").fetch(`http://object/${tag}`, upgrade),
          log,
          tag === "object-close" ? "peer" : "front",
        );
      case "seen": {
        // Give the last close events time to reach the log.
        await new Promise((resolve) => setTimeout(resolve, 300));
        const entries = {};
        const logs = [seen, await env.LOG.getByName("log").read(), await (await env.BACK.fetch("http://back/seen")).json()];
        for (const log of logs)
          for (const [logged, entry] of Object.entries(log))
            entries[logged] = [...(entries[logged] ?? []), ...entry];
        // Sorted, since the logs fill in no fixed order.
        return Response.json(Object.fromEntries(Object.keys(entries).sort().map(
          (logged) => [logged, entries[logged].sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1))])));
      }
    }
    return new Response("not found", { status: 404 });
  },
};
