// A stateless Worker passes capabilities to a Durable Object, which runs in
// another isolate in celld, on every call: an RpcTarget and a function, each
// holding 32 KiB, and a stub it keeps, duplicated for each call
// (rpc_params_dup_stubs). Each call releases what it took once it ends, so
// the Worker's memory stays flat over many calls (rpc/foreign-call-params
// diffs the releases with workerd). Each step makes `n` calls and reports how
// many of the params were disposed.
import { DurableObject, RpcStub, RpcTarget } from "cloudflare:workers";

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

function param() {
  const bytes = new Uint8Array(32 * 1024).fill(1);
  const fn = () => bytes.length;
  fn[Symbol.dispose] = () => {
    disposed += 1;
  };
  return fn;
}

export class Obj extends DurableObject {
  take(...values) {
    return values.length;
  }
}

export default {
  async fetch(request, env) {
    const n = Number(new URL(request.url).searchParams.get("n"));
    const object = env.OBJ.getByName("callee");
    const stub = new RpcStub(new Param());
    disposed = 0;
    for (let i = 0; i < n; i++) await object.take(new Param(), param(), stub);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const released = disposed;
    stub[Symbol.dispose]();
    await new Promise((resolve) => setTimeout(resolve, 50));
    return Response.json({ calls: n, released, stub: disposed - released });
  },
};
