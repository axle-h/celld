// Holds one connection to the upstream's echo port, opened by a request
// (kept running by waitUntil) or by a Durable Object (used again in its later
// events), and records everything that arrives on it after its own echo.
import { connect } from "cloudflare:sockets";
import { DurableObject } from "cloudflare:workers";

const dec = new TextDecoder();

async function hold(port, record) {
  const socket = connect(`127.0.0.1:${port}`);
  const writer = socket.writable.getWriter();
  await writer.write(new TextEncoder().encode("back"));
  writer.releaseLock();
  const reader = socket.readable.getReader();
  const first = await reader.read();
  // Everything after the echo, until the connection ends or 4 s pass.
  const watching = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return void (record.ended = true);
      record.received.push(dec.decode(value));
    }
  })().catch((error) => record.received.push(`error: ${error.message}`));
  return { first: dec.decode(first.value), watching: Promise.race([watching, new Promise((resolve) => setTimeout(resolve, 4000))]) };
}

const fromRequest = { received: [], ended: false };

export class Holder extends DurableObject {
  record = { received: [], ended: false };
  async hold(port) {
    const { first, watching } = await hold(port, this.record);
    this.watching = watching;
    return first;
  }
  report() {
    return this.record;
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const holder = url.searchParams.get("holder");
    if (url.pathname === "/hold") {
      const port = url.searchParams.get("port");
      if (holder === "object") return new Response(await env.HOLDER.getByName("a").hold(port));
      const { first, watching } = await hold(port, fromRequest);
      ctx.waitUntil(watching);
      return new Response(first);
    }
    if (url.pathname === "/report") {
      // Time for anything a forged write sent to come back.
      await new Promise((resolve) => setTimeout(resolve, 300));
      return Response.json(holder === "object" ? await env.HOLDER.getByName("a").report() : fromRequest);
    }
    return new Response("not found", { status: 404 });
  },
};
