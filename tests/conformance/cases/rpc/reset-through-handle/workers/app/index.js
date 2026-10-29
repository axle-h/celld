// A Durable Object hands out an RpcTarget that calls its ctx.abort(), and
// another Durable Object calls it (plan 1.30). In workerd the abort fails
// the call with its reason, the handle's later calls with workerd's
// post-abort text, and the stub that reached the aborted instance with the
// reason; a fresh stub reaches a new instance. celld refused every later
// call to the object, fresh stubs' too, until its cell was released.
import { DurableObject, RpcTarget } from "cloudflare:workers";

async function attempt(fn) {
  try {
    return await fn();
  } catch (error) {
    return `${error.name}: ${error.message}`;
  }
}

class Handle extends RpcTarget {
  #ctx;
  constructor(ctx) {
    super();
    this.#ctx = ctx;
  }
  abort() {
    this.#ctx.abort("aborted through a handle");
    return "returned";
  }
}

export class Obj extends DurableObject {
  calls = 0;

  count() {
    this.calls += 1;
    return this.calls;
  }

  handle() {
    return new Handle(this.ctx);
  }

  async viaHandle(name) {
    const stub = this.env.OBJ.getByName(name);
    const handle = await stub.handle();
    return {
      abort: await attempt(() => handle.abort()),
      again: await attempt(() => handle.abort()),
      stub: await attempt(() => stub.count()),
      fresh: await attempt(() => this.env.OBJ.getByName(name).count()),
    };
  }
}

export default {
  async fetch(request, env) {
    return Response.json(await env.OBJ.getByName("caller").viaHandle("target"));
  },
};
