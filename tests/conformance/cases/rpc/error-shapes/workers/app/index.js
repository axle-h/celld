// Error shapes celld does not match, whatever enhanced_error_serialization
// says: a DOMException's `code` is an own property in workerd, and it
// crosses RPC, as a result or a param, and storage as a DOMException; an
// Error's stack starts with the message it was made with, not the one it
// has when the stack is first read.
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

export class Errors extends WorkerEntrypoint {
  dom() { return new DOMException("dom", "NotFoundError"); }
  takes(value) { return shape(value); }
}

export class Store extends DurableObject {
  async roundTrip() {
    await this.ctx.storage.put("dom", new DOMException("dom", "NotFoundError"));
    return shape(await this.ctx.storage.get("dom"));
  }
}

const shape = (value) => ({
  type: Object.getPrototypeOf(value)?.constructor?.name ?? null,
  name: value.name,
  own: Reflect.ownKeys(value).map(String).filter((key) => !key.startsWith("Symbol(")).sort(),
});

export default {
  async fetch(request, env) {
    const changed = new Error("made");
    changed.message = "changed";
    let refused;
    try {
      structuredClone(() => 1);
    } catch (error) {
      refused = shape(error);
    }
    return Response.json({
      fresh: shape(new DOMException("dom", "NotFoundError")),
      cloned: shape(structuredClone(new DOMException("dom", "NotFoundError"))),
      returned: shape(await env.SELF.dom()),
      param: await env.SELF.takes(new DOMException("dom", "NotFoundError")),
      stored: await env.STORE.get(env.STORE.idFromName("x")).roundTrip(),
      refused,
      stack: changed.stack.split("\n")[0],
    });
  },
};
