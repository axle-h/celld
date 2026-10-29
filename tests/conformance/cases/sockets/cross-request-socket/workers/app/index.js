// A socket from cloudflare:sockets is an I/O object of the request or
// Durable Object that opened it (plan 1.50). Each use of its streams from a
// later request is refused with workerd's cross-request error, whether the
// opening request is still running (waitUntil) or has ended; from another
// Durable Object, reads are refused with the cross-object error and writes
// never settle. close(), opened, closed, getReader() and startTls() are not
// refused. The object that opened a socket uses it in its later events.
// One isolate (the case's env), so the later request sees the stashed
// sockets. The upstream's echo port answers what it reads.
import { connect } from "cloudflare:sockets";
import { DurableObject } from "cloudflare:workers";

const enc = new TextEncoder();
const dec = new TextDecoder();

// A use that has not settled after 1.5 s reports "<pending>".
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

// One socket per use, so a refusal that errors a stream affects no other row.
const USES = {
  write: (s) => s.writable.getWriter().write(enc.encode("x")).then(() => "written"),
  read: (s) => s.readable.getReader().read().then(({ value, done }) => (done ? "<eof>" : dec.decode(value))),
  echo: (s) => echo(s, "later"),
  writerClose: (s) => s.writable.getWriter().close().then(() => "closed"),
  readableCancel: (s) => s.readable.cancel().then(() => "cancelled"),
  close: (s) => s.close().then(() => "closed"),
  opened: (s) => s.opened.then(() => "opened"),
  closed: (s) => s.closed.then(() => "closed"),
  startTls: (s) => "upgraded:" + typeof s.startTls(),
  getReader: (s) => (s.readable.getReader(), "reader"),
};

async function openAll(port) {
  const sockets = {};
  for (const name of Object.keys(USES)) {
    sockets[name] = connect(`127.0.0.1:${port}`, name === "startTls" ? { secureTransport: "starttls" } : undefined);
  }
  return { sockets, first: await attempt(() => echo(sockets.echo, "first")) };
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
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const port = url.searchParams.get("port");
    switch (url.pathname) {
      case "/shape": {
        const socket = connect(`127.0.0.1:${port}`);
        const shape = {
          keys: Object.keys(socket),
          names: Object.getOwnPropertyNames(socket),
          construct: await attempt(() => new socket.constructor()),
          first: await attempt(() => echo(socket, "shape")),
        };
        await socket.close();
        return Response.json(shape);
      }
      case "/live/open": {
        const opened = await openAll(port);
        live = opened.sockets;
        // The opening request stays alive until the next step releases it.
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
        return Response.json(await env.HOLDER.getByName("a").open(port));
      case "/do/use":
        return Response.json(await env.HOLDER.getByName("a").use());
      case "/do/leaked":
        return Response.json(await env.HOLDER.getByName("b").useLeaked());
    }
    return new Response("not found", { status: 404 });
  },
};
