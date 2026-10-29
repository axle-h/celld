// A Durable Object's HTMLRewriter transform belongs to the object, not to
// the event that made it: one event transforms a document and keeps the
// response, and a later event reads it.
import { DurableObject } from "cloudflare:workers";

export class Holder extends DurableObject {
  transform() {
    this.response = new HTMLRewriter()
      .on("p", { element: (element) => element.setAttribute("seen", "1") })
      .transform(new Response("<p>object</p>", { headers: { "content-type": "text/html" } }));
    return "kept";
  }
  async read() {
    try {
      return await this.response.text();
    } catch (error) {
      return `${error.name}: ${error.message}`;
    }
  }
}

export default {
  async fetch(request, env) {
    const stub = env.HOLDER.getByName("a");
    return new Response(new URL(request.url).pathname === "/transform" ? await stub.transform() : await stub.read());
  },
};
