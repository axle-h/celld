// Calls refused at a Durable Object's input gate release what their params
// carried: each step queues `n` calls behind a blockConcurrencyWhile() that
// fails, through a stub the object returned and through the object's own
// stub, each passing an RpcTarget that holds 32 KiB. One Durable Object
// calls another of its class, so both share an isolate. Each refused call
// releases its param, so memory stays flat over many rounds
// (rpc/refused-call-params diffs the releases with workerd). Each step
// reports how many calls failed with the block's error and how many params
// were disposed.
import { DurableObject, RpcTarget } from "cloudflare:workers";

let disposed = 0;

class Param extends RpcTarget {
  constructor() {
    super();
    this.bytes = new Uint8Array(32 * 1024).fill(1);
  }
  [Symbol.dispose]() {
    disposed += 1;
  }
}

class Holder extends RpcTarget {
  take(value) {
    return typeof value;
  }
}

export class Obj extends DurableObject {
  holder() {
    return new Holder();
  }
  take(value) {
    return typeof value;
  }
  // Starts a block that fails, and answers once the input gate is closed,
  // so whatever the caller sends next queues behind it.
  block() {
    this.ctx.blockConcurrencyWhile(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      throw new Error("block failed");
    }).catch(() => {});
    return "blocked";
  }
  async round(name, n) {
    const callee = this.env.OBJ.getByName(name);
    const holder = await callee.holder();
    await callee.block();
    disposed = 0;
    const calls = [];
    for (let i = 0; i < n; i++) {
      calls.push(holder.take(new Param()), callee.take(new Param()));
    }
    const results = await Promise.allSettled(calls);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const refused = results.filter((result) => result.reason?.message === "block failed").length;
    return { calls: calls.length, refused, released: disposed };
  }
}

export default {
  async fetch(request, env) {
    const params = new URL(request.url).searchParams;
    // Each round has its own callee, so none queues behind an object an
    // earlier round's block is still resetting.
    const caller = env.OBJ.getByName("caller");
    return Response.json(await caller.round(`callee-${params.get("round")}`, Number(params.get("n"))));
  },
};
