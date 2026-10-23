// The shapes of RPC clients beyond the names they answer, which celld does
// not match yet (1.48): an RpcPromise's prototype chain, the own keys of
// stubs and pipeline nodes, a Durable Object stub's own keys, and the tags
// Object.prototype.toString() gives a service binding and a ctx.exports stub.
import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";

export class Host extends DurableObject {
  greet() {
    return "host";
  }
}

export class Local extends WorkerEntrypoint {}

class Target extends RpcTarget {
  greet() {
    return "target";
  }
}

export default {
  async fetch(request, env, ctx) {
    using stub = new RpcStub(new Target());
    const promise = stub.greet();
    await promise;
    const host = env.HOST.getByName("shapes");
    return Response.json({
      promiseIsPromise: promise instanceof Promise,
      stubKeys: Reflect.ownKeys(stub).map(String),
      promiseKeys: Reflect.ownKeys(promise).map(String),
      propertyKeys: Reflect.ownKeys(stub.greet).map(String),
      hostKeys: Object.keys(host),
      hostOwnKeys: Reflect.ownKeys(host).map(String),
      serviceTag: Object.prototype.toString.call(env.BACK),
      exportsTag: Object.prototype.toString.call(ctx.exports.Local),
    });
  },
};
