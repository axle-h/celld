// A webSocketMessage() handler waits on a timer when another event resets
// its Durable Object (ctx.abort(), or a failed blockConcurrencyWhile()).
// workerd drops the connection at once, and the client reads 1006; celld
// closes it at once too, but with 1011 (plan 1.59, found by 1.30). The rest
// of what waits on a reset object is `rpc/reset-waiters`.
import { DurableObject } from "cloudflare:workers";

const message = (error) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function attempt(fn) {
  try {
    return await fn();
  } catch (error) {
    return "threw " + message(error);
  }
}

function bounded(promise, ms = 2000) {
  return Promise.race([promise, sleep(ms).then(() => "hung")]);
}

export class Obj extends DurableObject {
  waiting = Promise.withResolvers();

  ping() {
    return "pong";
  }

  async started() {
    await this.waiting.promise;
    return "started";
  }

  async reset(kind) {
    if (kind === "abort") {
      this.ctx.abort(new Error("aborted"));
      return "abort returned";
    }
    await this.ctx.blockConcurrencyWhile(async () => {
      throw new Error("block threw");
    });
  }

  fetch() {
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws, data) {
    this.waiting.resolve();
    await sleep(5000);
    ws.send("handled " + data);
  }
}

async function waitAndReset(ns, name, kind, wait) {
  const waiter = wait();
  const started = await bounded(attempt(() => ns.getByName(name).started()));
  const reset = await bounded(attempt(() => ns.getByName(name).reset(kind)));
  return { started, reset, waiter: await bounded(waiter, 3000) };
}

export default {
  async fetch(request, env) {
    const [, test, kind] = new URL(request.url).pathname.split("/");
    const ns = env.OBJ;
    const name = `${test}-${kind}`;
    if (test === "websocket") {
      const response = await ns.getByName(name).fetch("http://x/", { headers: { upgrade: "websocket" } });
      const ws = response.webSocket;
      const events = [];
      ws.addEventListener("message", (event) => events.push(`message ${event.data}`));
      ws.addEventListener("error", () => events.push("error"));
      const closed = new Promise((resolve) => ws.addEventListener("close", (event) => {
        events.push(`close ${event.code}`);
        resolve("closed");
      }));
      ws.accept();
      ws.send("one");
      const out = await waitAndReset(ns, name, kind, () => closed);
      out.events = events;
      out.after = await bounded(attempt(() => ns.getByName(name).ping()));
      return Response.json(out);
    }
    return new Response("not found", { status: 404 });
  },
};
