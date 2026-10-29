// A Durable Object's TCP sockets live with the object across its events and
// close when the object leaves memory (plan 1.50): one idle, one with a read
// waiting on a silent peer. The case's env evicts an idle object after 1 s,
// and the node then holds no connection to the echo port.
import { connect } from "cloudflare:sockets";
import { DurableObject } from "cloudflare:workers";

export class Holder extends DurableObject {
  async open(port, read) {
    this.socket = connect(`127.0.0.1:${port}`);
    await this.socket.opened;
    if (read) {
      this.pending = this.socket.readable.getReader().read();
      this.pending.catch(() => {});
    }
    return "open";
  }
  async used() {
    return this.socket === undefined ? "new instance" : "same instance";
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const stub = env.HOLDER.getByName(url.searchParams.get("name"));
    if (url.pathname === "/open") {
      return new Response(await stub.open(url.searchParams.get("port"), url.searchParams.has("read")));
    }
    return new Response(await stub.used());
  },
};
