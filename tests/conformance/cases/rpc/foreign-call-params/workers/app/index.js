// A call to a Durable Object from a stateless Worker releases what its
// params carried once the call ends, though the callee never used them: an
// RpcTarget and a function are disposed, a Proxy presenting a plain object
// is duplicated by its dup() (rpc_params_dup_stubs) and the duplicate
// disposed, and the caller's stub, duplicated for the call, is disposed only
// by its caller. In celld the object runs in another isolate than the Worker
// (its stubs cannot cross yet, plan 3.1), so this is what keeps a caller
// that passes capabilities to one from holding each call's.
import { DurableObject, RpcStub, RpcTarget } from "cloudflare:workers";

const log = [];

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

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

// As a Cap'n Web stub presents itself: a Proxy of a plain object whose
// dup() makes another.
function proxy(name) {
  return new Proxy({}, {
    get(_target, prop) {
      if (prop === "dup") {
        return () => {
          log.push(`dup ${name}`);
          return proxy(`${name}'`);
        };
      }
      if (prop === Symbol.dispose) return () => log.push(`dispose ${name}`);
      return undefined;
    },
  });
}

export class Obj extends DurableObject {
  take(...values) {
    return values.map((value) => typeof value);
  }
}

export default {
  async fetch(request, env) {
    const object = env.OBJ.getByName("callee");
    const stub = new RpcStub(new Param("stub"));
    const taken = [];
    for (const value of [new Param("target"), param("function"), proxy("proxy"), stub]) {
      taken.push(await object.take(value));
    }
    taken.push(await object.take(new Param("first"), new Param("second")));
    await settle();
    const released = [...log];
    stub[Symbol.dispose]();
    await settle();
    return Response.json({ taken, released, afterCaller: log });
  },
};
