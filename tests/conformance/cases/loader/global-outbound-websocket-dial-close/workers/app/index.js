// The ends of a socket a Fetcher carries report the end of its connection
// as an error event, "Network connection lost.", by who closed first, as
// workerd's pipe reports it (plan 1.42): the caller's end before its close
// event when it closed first, and after it when it replied; the server end
// after its close event when it closed first, and never when it replied.
// A Dynamic Worker reaches its globalOutbound Fetcher, this script's
// `Outbound` entrypoint, with `new WebSocket()` (`dial-*`) and with a
// fetch() upgrade it accepts (`upgrade-*`); this script reaches itself
// through a service binding (`binding-*`), and `back` through another
// (`other-*`). The server end of a binding to this script reports nothing
// either way. On `*-caller-first` the caller
// closes first, on `*-server-first` the server end does, and on `*-half`
// the other end replies from its close listener rather than automatically.
// Each request answers what the caller's end saw; `/seen` answers what each
// server end saw, which lives in this isolate (the case's env).
import { WorkerEntrypoint } from "cloudflare:workers";

const seen = {};

const serve = (key) => {
  const log = (entry) => (seen[key] ??= []).push(entry);
  const [client, server] = Object.values(new WebSocketPair());
  const half = key.endsWith("caller-first-half");
  server.accept(half ? { allowHalfOpen: true } : undefined);
  server.addEventListener("message", (event) => {
    if (key.includes("server-first")) server.close(4001, "server first");
    else server.send(`server:${event.data}`);
  });
  if (half) server.addEventListener("close", (event) => server.close(event.code, "server replies"));
  server.addEventListener("error", (event) => log(["error", event.message]));
  server.addEventListener("close", (event) => log(["close", event.code, event.reason, event.wasClean]));
  return new Response(null, { status: 101, webSocket: client });
};

export class Outbound extends WorkerEntrypoint {
  fetch(request) {
    return serve(new URL(request.url).pathname.slice(1));
  }
}

// The caller's end: it sends "a", closes first on the server's echo, and
// with `half` replies to the server's Close from its close listener.
const CALLER = `
  const events = [];
  socket.addEventListener("error", (event) => events.push(["error", event.message]));
  await new Promise((resolve) => {
    socket.addEventListener("message", (event) => {
      events.push(event.data);
      socket.close(4000, "caller first");
    });
    socket.addEventListener("close", (event) => {
      events.push(["close", event.code, event.reason, event.wasClean]);
      if (half) socket.close(event.code, "caller replies");
      setTimeout(resolve, 200);
    });
    if (opened) opened.then(() => socket.send("a"));
    else socket.send("a");
  });
  return events;
`;
const caller = new Function("socket", "half", "opened", `return (async () => {${CALLER}})();`);

const CHILD = `
export default {
  async fetch(request) {
    const key = new URL(request.url).pathname.slice(1);
    const half = key.endsWith("server-first-half");
    let socket;
    let opened = null;
    if (key.startsWith("dial-")) {
      socket = new WebSocket("ws://outbound.test/" + key);
      opened = new Promise((resolve) => socket.addEventListener("open", resolve));
    } else {
      const response = await fetch("http://outbound.test/" + key, { headers: { Upgrade: "websocket" } });
      socket = response.webSocket;
      socket.accept(half ? { allowHalfOpen: true } : undefined);
    }
    return Response.json(await (async () => {${CALLER}})());
  },
};
`;

export default {
  async fetch(request, env, ctx) {
    const key = new URL(request.url).pathname.slice(1);
    if (key === "seen") {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return Response.json({ ...seen, ...(await (await env.BACK.fetch("http://back/seen")).json()) });
    }
    if (key.startsWith("serve-")) return serve(key.slice("serve-".length));
    if (key.startsWith("binding-") || key.startsWith("other-")) {
      const response = key.startsWith("other-")
        ? await env.BACK.fetch(`http://back/${key}`, { headers: { Upgrade: "websocket" } })
        : await env.SELF.fetch(`http://self/serve-${key}`, { headers: { Upgrade: "websocket" } });
      const socket = response.webSocket;
      const half = key.endsWith("server-first-half");
      socket.accept(half ? { allowHalfOpen: true } : undefined);
      return Response.json(await caller(socket, half, null));
    }
    // A dialed socket cannot be half-open: its Worker replies from its close
    // listener only under a date before web_socket_auto_reply_to_close.
    const date = key === "dial-server-first-half" ? "2026-01-01" : "2026-09-04";
    const child = env.LOADER.get(`child-${date}`, () => ({
      compatibilityDate: date,
      mainModule: "child.js",
      modules: { "child.js": CHILD },
      globalOutbound: ctx.exports.Outbound({}),
    }));
    return child.getEntrypoint().fetch(request);
  },
};
