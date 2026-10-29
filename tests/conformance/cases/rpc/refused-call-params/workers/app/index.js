// A call refused before its callee received it releases what its params
// carried: an RpcTarget, a function and a stub passed to a Durable Object
// whose blockConcurrencyWhile() then fails. Each call queues behind the
// block, through a stub the object returned (`/stub`) or the object's own
// stub (`/object`), and fails with the block's error; the RpcTarget and the
// function the calls took are disposed, and the caller's stub, duplicated
// for the call (rpc_params_dup_stubs), is disposed only by its caller. One
// Durable Object calls another of its class, so both share an isolate.
import { DurableObject, RpcStub, RpcTarget } from "cloudflare:workers";

let log = [];

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

async function attempt(fn) {
  try {
    return await fn();
  } catch (error) {
    return `${error.name}: ${error.message}`;
  }
}

class Param extends RpcTarget {
  constructor(name) {
    super();
    this.name = name;
  }
  [Symbol.dispose]() {
    log.push(`dispose ${this.name}`);
  }
}

function param(name) {
  const fn = () => name;
  fn[Symbol.dispose] = () => log.push(`dispose ${name}`);
  return fn;
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
      await new Promise((resolve) => setTimeout(resolve, 100));
      throw new Error("block failed");
    }).catch(() => {});
    return "blocked";
  }
  async run(via) {
    log = [];
    const callee = this.env.OBJ.getByName(`callee-${via}`);
    const target = via === "stub" ? await callee.holder() : callee;
    const blocked = await callee.block();
    const stub = new RpcStub(new Param("stub"));
    const results = await Promise.all([
      attempt(() => target.take(new Param("target"))),
      attempt(() => target.take(param("function"))),
      attempt(() => target.take(stub)),
    ]);
    await settle();
    const released = [...log].sort();
    stub[Symbol.dispose]();
    await settle();
    return { blocked, results, released, afterCaller: log.sort() };
  }
}

export default {
  async fetch(request, env) {
    const via = new URL(request.url).pathname.slice(1);
    return Response.json(await env.OBJ.getByName(`caller-${via}`).run(via));
  },
};
