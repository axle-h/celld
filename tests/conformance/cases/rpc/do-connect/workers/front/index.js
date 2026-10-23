// A Durable Object stub's `connect()` is the Fetcher's own method, not RPC:
// workerd hands the object's connect handler a Socket, and the stub's
// Socket reads what the handler writes. celld has no connect handlers and
// refuses the call (1.48). Its `fetch` is one function across stubs too.
import { DurableObject } from "cloudflare:workers";

async function attempt(fn) {
  try {
    const value = await fn();
    return { type: typeof value, value: value ?? null };
  } catch (error) {
    return { error: `${error.name}: ${error.message}` };
  }
}

export class WithHandler extends DurableObject {
  async connect(socket) {
    await this.ctx.storage.put("seen", {
      args: arguments.length,
      socket: Object.prototype.toString.call(socket),
    });
    const writer = socket.writable.getWriter();
    await writer.write(new TextEncoder().encode("hello from the object"));
    await writer.close();
  }

  seen() {
    return this.ctx.storage.get("seen");
  }
}

export class WithoutHandler extends DurableObject {}

async function readAll(socket) {
  const reader = socket.readable.getReader();
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return text;
    text += new TextDecoder().decode(value);
  }
}

async function open(connect) {
  let socket;
  try {
    socket = connect();
  } catch (error) {
    return { threw: `${error.name}: ${error.message}` };
  }
  return {
    opened: await attempt(() => socket.opened.then((info) => JSON.stringify(info))),
    read: await attempt(() => readAll(socket)),
    closed: await attempt(() => socket.closed.then(() => "closed")),
  };
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === "/handler") {
      const stub = env.WITH.getByName("a");
      return Response.json({
        ...(await open(() => stub.connect("example.com:80"))),
        seen: await attempt(() => stub.seen()),
      });
    }
    if (path === "/no-handler") {
      const stub = env.WITHOUT.getByName("a");
      return Response.json(await open(() => stub.connect("example.com:80")));
    }
    if (path === "/arguments") {
      const stub = env.WITHOUT.getByName("a");
      return Response.json({
        none: await open(() => stub.connect()),
        object: await open(() => stub.connect({ hostname: "example.com", port: 80 })),
        noPort: await open(() => stub.connect("example.com")),
        detached: await open(() => (0, stub.connect)("example.com:80")),
      });
    }
    if (path === "/identity") {
      const a = env.WITH.getByName("a");
      const b = env.WITHOUT.getByName("b");
      return Response.json({ connect: a.connect === b.connect, fetch: a.fetch === b.fetch });
    }
    return new Response("not found", { status: 404 });
  },
};
