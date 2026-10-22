// How a WebSocket answers the Close its peer sends, under a Worker's
// compatibility date and flags, which each flags/websocket-*-reply Worker
// sets in its wrangler.jsonc.
//
// With `web_socket_auto_reply_to_close` (on from 2026-04-07, turned off by
// `web_socket_manual_reply_to_close`), a socket accepted with `accept()`
// replies to a Close with the same code and reason before its close event
// fires, and is CLOSED then; a later close() does nothing. Without it the
// socket is half-open (CLOSING) until the Worker calls close().
// `accept({allowHalfOpen})` chooses for one socket. A hibernatable socket
// never replies by itself, whatever the flag (src/workerd/api/web-socket.c++,
// LegacyWebSocketAdapter::readLoop).
//
// Every route answers a client's frame with `echo:<frame>`. Each close
// listener tries to close with its own code and a reason naming the
// readyState it saw, so the client sees which reply won.
import { DurableObject } from "cloudflare:workers";

// Accept a socket and return its client end. `onClose` runs in the close
// listener.
function serve(options, onClose) {
  const [client, server] = Object.values(new WebSocketPair());
  server.accept(options);
  server.addEventListener("message", (event) => server.send(`echo:${event.data}`));
  if (onClose) server.addEventListener("close", (event) => onClose(server, event));
  return new Response(null, { status: 101, webSocket: client });
}

const closeNow = (code) => (server, event) =>
  server.close(code, `${event.code} seen in readyState ${server.readyState}`);

// Send from the close listener, then close: a half-open socket still sends.
// Under the automatic reply both throw or do nothing.
const sendThenClose = (code) => (server, event) => {
  let sent;
  try {
    server.send(`bye from readyState ${server.readyState}`);
    sent = "sent";
  } catch (error) {
    sent = error.name;
  }
  server.close(code, `${event.code} ${sent}`);
};

// close() with no code sends an empty Close, which the peer reads as 1005.
const closeWithoutCode = (server) => server.close();

const closeLater = (code) => (server, event) => {
  const seen = server.readyState;
  setTimeout(() => server.close(code, `${event.code} seen in readyState ${seen}, later`), 20);
};

// A pair inside this isolate: `a` closes, and `b` replies or not.
async function pair(reply) {
  const events = [];
  const [a, b] = Object.values(new WebSocketPair());
  a.accept();
  b.accept();
  let closes = 0;
  let settle;
  const settled = new Promise((resolve) => (settle = resolve));
  const closed = () => ++closes === 2 && settle();
  a.addEventListener("close", (event) => {
    events.push(["a close", event.code, event.reason, event.wasClean, a.readyState]);
    closed();
  });
  b.addEventListener("close", (event) => {
    events.push(["b close", event.code, event.reason, event.wasClean, b.readyState]);
    if (reply) b.close(4011, "b replies");
    events.push(["b after its close()", b.readyState]);
    closed();
  });
  a.close(4010, "a closes");
  events.push(["a after close()", a.readyState]);
  await Promise.race([settled, new Promise((resolve) => setTimeout(resolve, 300))]);
  events.push(["end", a.readyState, b.readyState]);
  return Response.json(events);
}

// What each close listener and `webSocketClose` saw, kept in storage: the
// object can be reset once its last socket goes.
// What close() and send() throw, each on a fresh same-isolate pair: the
// error's name and message, or "ok".
function closeErrors() {
  const attempt = (action) => {
    const [a, b] = Object.values(new WebSocketPair());
    a.accept();
    b.accept();
    try {
      action(a);
      return "ok";
    } catch (error) {
      return `${error.name}: ${error.message}`;
    }
  };
  const close = (...args) => attempt((ws) => ws.close(...args));
  return Response.json({
    "close(999)": close(999),
    "close(null)": close(null),
    "close(1000)": close(1000),
    "close(1001)": close(1001),
    "close(1004)": close(1004),
    "close(1005)": close(1005),
    "close(1006)": close(1006),
    "close(1014)": close(1014),
    "close(1015)": close(1015),
    "close(2999)": close(2999),
    "close(4999)": close(4999),
    "close(5000)": close(5000),
    "close(1000.9)": close(1000.9),
    'close("4000")': close("4000"),
    "close(4000, 124 bytes)": close(4000, "x".repeat(124)),
    "close(4000, 123 bytes)": close(4000, "é".repeat(61) + "x"),
    'close(undefined, "why")': close(undefined, "why"),
    "send() after close()": attempt((ws) => {
      ws.close(4000, "done");
      ws.send("late");
    }),
  });
}

export class Sockets extends DurableObject {
  seen = [];

  constructor(ctx, env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.seen = (await ctx.storage.get("seen")) ?? [];
    });
  }

  note(entry) {
    this.seen.push(entry);
    return this.ctx.storage.put("seen", this.seen);
  }

  fetch(request) {
    const { pathname } = new URL(request.url);
    const record = (onClose) => (server, event) => {
      this.note([pathname, event.code, server.readyState]);
      onClose(server, event);
    };
    switch (pathname) {
      case "/do/now":
        return serve(undefined, record(closeNow(4005)));
      case "/do/later":
        return serve(undefined, record(closeLater(4006)));
      case "/do/send":
        return serve(undefined, record(sendThenClose(4007)));
      // Never replies: a half-open socket lives as long as its connection.
      case "/do/silent":
        return serve(undefined, record(() => {}));
      case "/do/seen":
        return Response.json(this.seen);
      case "/do/hibernatable": {
        const [client, server] = Object.values(new WebSocketPair());
        this.ctx.acceptWebSocket(server);
        return new Response(null, { status: 101, webSocket: client });
      }
    }
    return new Response("not found", { status: 404 });
  }

  webSocketMessage(ws, message) {
    ws.send(`echo:${message}`);
  }

  // Replies with nothing: the client of a hibernatable socket then sees 1006.
  // The socket is CLOSING meanwhile.
  async webSocketClose(ws, code) {
    await this.note(["/do/hibernatable", code, ws.readyState]);
  }
}

// The relay: the front accepts the socket a service binding returned and
// relays it through its own pair, as service-bindings/ws-101-client-close
// does.
async function relay(request, env) {
  const response = await env.BACK.fetch(request);
  const back = response.webSocket;
  back.accept();
  const [client, server] = Object.values(new WebSocketPair());
  server.accept();
  server.addEventListener("message", (event) => back.send(event.data));
  back.addEventListener("message", (event) => server.send(`front:${event.data}`));
  server.addEventListener("close", (event) => back.close(event.code, `front saw ${event.code}`));
  back.addEventListener("close", (event) => {
    server.close(4021, `front relayed ${event.code} ${event.reason}`);
  });
  return new Response(null, { status: 101, webSocket: client });
}

// A caller that accepts the socket a subrequest's 101 returned and closes it
// first: what its close event reports is the other side's reply.
async function caller(target, path) {
  const response = await target.fetch(`http://sockets${path}`, {
    headers: { Upgrade: "websocket" },
  });
  const ws = response.webSocket;
  ws.accept();
  const closed = new Promise((resolve) => {
    ws.addEventListener("close", (event) => {
      resolve([event.code, event.reason, event.wasClean, ws.readyState]);
    });
  });
  ws.close(4030, "caller closes");
  const after = ws.readyState;
  const reply = await Promise.race([
    closed,
    new Promise((resolve) => setTimeout(() => resolve("no reply"), 300)),
  ]);
  return Response.json({ after, reply, end: ws.readyState });
}

// The Worker behind BACK, for /relay and /caller/back.
export const back = {
  fetch() {
    return serve(undefined, (server, event) => {
      server.close(4022, `back saw ${event.code} ${event.reason}`.trim());
    });
  },
};

export default {
  fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith("/do/")) return env.SOCKETS.getByName("sockets").fetch(request);
    switch (pathname) {
      case "/accepted":
        return serve();
      case "/now":
        return serve(undefined, closeNow(4001));
      case "/later":
        return serve(undefined, closeLater(4002));
      case "/send":
        return serve(undefined, sendThenClose(4008));
      case "/no-code":
        return serve(undefined, closeWithoutCode);
      // The server closes first, with no code, when the client's frame arrives.
      case "/server-no-code": {
        const [client, server] = Object.values(new WebSocketPair());
        server.accept();
        server.addEventListener("message", () => server.close());
        return new Response(null, { status: 101, webSocket: client });
      }
      case "/half-open":
        return serve({ allowHalfOpen: true }, closeNow(4003));
      case "/no-half-open":
        return serve({ allowHalfOpen: false }, closeNow(4004));
      case "/relay":
        return relay(request, env);
      case "/caller/back":
        return caller(env.BACK, "/");
      case "/caller/do":
        return caller(env.SOCKETS.getByName("sockets"), "/do/now");
      case "/close-errors":
        return closeErrors();
      case "/pair/reply":
        return pair(true);
      case "/pair/silent":
        return pair(false);
    }
    return new Response("not found", { status: 404 });
  },
};
