// A failed blockConcurrencyWhile() resets its Durable Object. A stub that
// saw the reset stays broken in workerd: its later calls, even well after,
// throw the block's error. A fresh stub from getByName() reaches a new
// instance. In celld the old stub reaches the new instance too (plan 1.30).
// From a stateless Worker (`/stateless`) and from another Durable Object of
// the class (`/object`).
import { DurableObject } from "cloudflare:workers";

async function attempt(fn) {
  try {
    return await fn();
  } catch (error) {
    return `${error.name}: ${error.message}`;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function probe(namespace, name) {
  const stub = namespace.getByName(name);
  const before = await attempt(() => stub.count());
  const failed = await attempt(() =>
    stub.fail().then(() => "blocked"));
  await sleep(200);
  return {
    before,
    failed,
    oldStub: await attempt(() => stub.count()),
    freshStub: await attempt(() => namespace.getByName(name).count()),
    oldStubAgain: await attempt(() => stub.count()),
  };
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
  probe(name) {
    return probe(this.env.OBJ, name);
  }
}

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname === "/stateless") {
      return Response.json(await probe(env.OBJ, "from-stateless"));
    }
    return Response.json(await env.OBJ.getByName("caller").probe("from-object"));
  },
};
