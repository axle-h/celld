// A Durable Object transforms an endless source and never reads the result.
// The transform is rooted until the cell is released, so without
// backpressure the parser's output grows until the isolate's memory limit
// (plan 1.50). With it, the source is read only as the unread readable has
// room, so memory stays bounded and the object answers its later events.
import { DurableObject } from "cloudflare:workers";

export class Holder extends DurableObject {
  start() {
    const source = new ReadableStream({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode("<p>x</p>".repeat(512)));
      },
    });
    // Kept, never read.
    this.transformed = new HTMLRewriter()
      .on("p", { element: (element) => element.setAttribute("seen", "1") })
      .transform(new Response(source, { headers: { "content-type": "text/html" } }));
    return "started";
  }
  ping() {
    return "pong";
  }
}

export default {
  async fetch(request, env) {
    const stub = env.HOLDER.getByName("a");
    const path = new URL(request.url).pathname;
    if (path === "/start") return new Response(await stub.start());
    return new Response(await stub.ping());
  },
};
