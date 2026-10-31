// A stateless Worker's WebSocket events do I/O after its response has gone:
// each event calls a Durable Object twice, and the message event echoes
// only once both calls answered, so the client closes after them. workerd
// keeps the request while its socket is open, so every call answers, and
// the waitUntil work the events add runs to its end.
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
      log.push(entry).then((pushed) => log.push(`${pushed} answered`));
    server.addEventListener("message", (event) => {
      ctx.waitUntil(record(`message ${event.data}`).then(() => server.send(`echo:${event.data}`)));
    });
    server.addEventListener("close", (event) => {
      ctx.waitUntil(record(`close ${event.code}`));
      server.close(event.code, "bye");
    });
    return new Response(null, { status: 101, webSocket: client });
  },
};
