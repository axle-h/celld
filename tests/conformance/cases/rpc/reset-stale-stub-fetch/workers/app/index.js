// A stub whose first call was fetch() binds to the instance it reached, as
// one whose first call was RPC does (`rpc/reset-stale-stubs`): once that
// instance is reset, its later calls throw the reset's error. celld's fetch()
// carries no instance, so such a stub reaches the new instance (plan 1.59).
// - `/fetched`: the stub fetched, and another stub reset the object.
// - `/reset-by-fetch`: the stub's fetch() reset the object.
import { DurableObject } from "cloudflare:workers";

async function attempt(fn) {
  try {
    return await fn();
  } catch (error) {
    return `${error.name}: ${error.message}`;
  }
}

export class Obj extends DurableObject {
  calls = 0;

  count() {
    this.calls += 1;
    return this.calls;
  }

  async fail() {
    await this.ctx.blockConcurrencyWhile(async () => {
      throw new Error("block failed");
    });
  }

  async fetch(request) {
    if (new URL(request.url).pathname === "/fail") await this.fail();
    return new Response(`fetched ${this.count()}`);
  }
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    const fetched = env.OBJ.getByName(path);
    const out = { first: await attempt(() => fetched.fetch("http://x/").then((r) => r.text())) };
    if (path === "/fetched") out.reset = await attempt(() => env.OBJ.getByName(path).fail());
    else out.reset = await attempt(() => fetched.fetch("http://x/fail").then((r) => r.text()));
    out.count = await attempt(() => fetched.count());
    out.fetch = await attempt(() => fetched.fetch("http://x/").then((r) => r.text()));
    return Response.json(out);
  },
};
