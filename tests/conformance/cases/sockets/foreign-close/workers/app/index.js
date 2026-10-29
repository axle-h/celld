// What close() and startTls() from code that does not own a socket do in
// workerd (plan 1.51): another request's close() resolves, and then the
// socket's `closed` rejects with the cross-request error while that request
// runs (it never settles once the request has ended); another Durable
// Object's close() leaves the owner's `closed` rejected and its writable
// closing. startTls() from another owner returns a Socket whose `opened`
// never settles and whose writes are refused. The owner's own startTls()
// resolves `opened` before the handshake, which then fails the first write
// ("Network connection lost.") against a peer that does not speak TLS.
// celld leaves the owner's socket alone and rejects the foreign startTls()
// with the host's refusal, and its `opened` waits for the handshake.
import { connect } from "cloudflare:sockets";
import { DurableObject } from "cloudflare:workers";

const enc = new TextEncoder();
const dec = new TextDecoder();

async function attempt(fn) {
  let timer;
  try {
    const value = await Promise.race([
      Promise.resolve().then(fn),
      new Promise((resolve) => (timer = setTimeout(() => resolve("<pending>"), 1500))),
    ]);
    return { ok: value ?? null };
  } catch (error) {
    return { error: `${error?.name}: ${error?.message}` };
  } finally {
    clearTimeout(timer);
  }
}

async function echo(socket, text) {
  const writer = socket.writable.getWriter();
  await writer.write(enc.encode(text));
  writer.releaseLock();
  const reader = socket.readable.getReader();
  const { value, done } = await reader.read();
  reader.releaseLock();
  return done ? "<eof>" : dec.decode(value);
}

const USES = {
  closeThenClosed: (s) => s.close().then(() => s.closed).then(() => "closed"),
  startTlsOpened: (s) => s.startTls().opened.then(() => "opened"),
  startTlsWrite: (s) => s.startTls().writable.getWriter().write(enc.encode("x")).then(() => "written"),
};

async function openAll(port) {
  const sockets = {};
  for (const name of Object.keys(USES)) {
    sockets[name] = connect(`127.0.0.1:${port}`, name.startsWith("startTls") ? { secureTransport: "starttls" } : undefined);
  }
  return { sockets, first: await attempt(() => sockets.closeThenClosed.opened.then(() => "opened")) };
}

async function useAll(sockets) {
  const out = {};
  for (const [name, use] of Object.entries(USES)) out[name] = await attempt(() => use(sockets[name]));
  return out;
}

let live = null;
let release = null;
let ended = null;
let leaked = null;

export class Holder extends DurableObject {
  async open(port) {
    const { sockets, first } = await openAll(port);
    this.sockets = sockets;
    leaked = sockets;
    return first;
  }
  use() {
    return useAll(this.sockets);
  }
  useLeaked() {
    return useAll(leaked);
  }
  // The owner's sockets after another object closed and upgraded them.
  afterLeak() {
    return Promise.all([
      attempt(() => this.sockets.closeThenClosed.closed.then(() => "closed")),
      attempt(() => echo(this.sockets.closeThenClosed, "again")),
      attempt(() => echo(this.sockets.startTlsOpened, "again")),
    ]);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const port = url.searchParams.get("port");
    switch (url.pathname) {
      case "/live/open": {
        const opened = await openAll(port);
        live = opened.sockets;
        ctx.waitUntil(new Promise((resolve) => {
          release = resolve;
          setTimeout(resolve, 8000);
        }));
        return Response.json({ first: opened.first });
      }
      case "/live/use": {
        const out = await useAll(live);
        release?.();
        return Response.json(out);
      }
      case "/ended/open": {
        const opened = await openAll(port);
        ended = opened.sockets;
        return Response.json({ first: opened.first });
      }
      case "/ended/use":
        return Response.json(await useAll(ended));
      case "/do/open":
        return Response.json(await env.HOLDER.getByName(url.searchParams.get("name")).open(port));
      case "/do/use":
        return Response.json(await env.HOLDER.getByName("own").use());
      case "/do/leaked":
        return Response.json(await env.HOLDER.getByName("b").useLeaked());
      case "/do/after-leak":
        return Response.json(await env.HOLDER.getByName("a").afterLeak());
    }
    return new Response("not found", { status: 404 });
  },
};
