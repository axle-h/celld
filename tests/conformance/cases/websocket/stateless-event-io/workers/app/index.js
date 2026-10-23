// A stateless Worker's WebSocket events do I/O after its response has gone:
// each event calls a Durable Object and records whether the call answered.
// workerd keeps the request while its socket is open, so every call
// answers. In celld the request ends with the socket's last read, and the
// close event's call never answers (plan 1.42).
import { DurableObject } from "cloudflare:workers";

export class Log extends DurableObject {
  entries = [];
  push(entry) {
    this.entries.push(entry);
    return entry;
  }
  read() {
    return this.entries;
  }
}

export default {
  async fetch(request, env, ctx) {
    const log = env.LOG.getByName("log");
    if (new URL(request.url).pathname === "/seen") {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return Response.json(await log.read());
    }
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    const record = (entry) =>
      ctx.waitUntil(log.push(entry).then((pushed) => log.push(`${pushed} answered`)));
    server.addEventListener("message", (event) => {
      record(`message ${event.data}`);
      server.send(`echo:${event.data}`);
    });
    server.addEventListener("close", (event) => {
      record(`close ${event.code}`);
      server.close(event.code, "bye");
    });
    return new Response(null, { status: 101, webSocket: client });
  },
};
