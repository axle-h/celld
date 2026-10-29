// A stub a stateless Worker's handler made belongs to that request: another
// request can neither call it nor pass it on (workerd's IoContext rule).
// celld runs every stateless request outside any request context, so a stub
// made in one is another's to use (plan 1.57). `/keep` hands such a stub's
// target, from an entrypoint's call, a param it keeps with dup(): it belongs
// to `/keep`'s request, which can pass it on, where celld refuses that as
// another request's. A Durable Object's stubs, in workerd, are its own across
// its events: one event keeps a param, a later one uses and passes it
// (`/object-keep`, `/object-use`); celld refuses passing it on.
import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";

class Named extends RpcTarget {
  hi() {
    return "hi";
  }
}

class Sink extends RpcTarget {
  take(stub) {
    return typeof stub;
  }
}

class Greeter extends RpcTarget {
  constructor(name) {
    super();
    this.name = name;
  }
  hi() {
    return `hi ${this.name}`;
  }
}

class HiSink extends RpcTarget {
  take(stub) {
    return stub.hi();
  }
}

let kept;
let param;

class Keeper extends RpcTarget {
  keep(value) {
    param = value.dup();
    return "kept";
  }
  passKept(sink) {
    return sink.take(param);
  }
}

export class Entry extends WorkerEntrypoint {
  give(keeperStub) {
    return keeperStub.keep(new Greeter("given"));
  }
}

export class Obj extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.keeper = new RpcStub(new Keeper());
  }
  keep() {
    return this.keeper.keep(new Greeter("object"));
  }
  async use() {
    return {
      call: await attempt(() => param.hi()),
      pass: await attempt(() => new RpcStub(new HiSink()).take(param)),
      throughTarget: await attempt(() => this.keeper.passKept(new RpcStub(new HiSink()))),
    };
  }
}

async function attempt(fn) {
  try {
    return await fn();
  } catch (error) {
    return `${error.name}: ${error.message}`;
  }
}

export default {
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    if (path === "/keep") {
      const keeper = new RpcStub(new Keeper());
      return Response.json({
        give: await attempt(() => ctx.exports.Entry.give(keeper)),
        call: await attempt(() => param.hi()),
        pass: await attempt(() => new RpcStub(new HiSink()).take(param)),
        throughTarget: await attempt(() => keeper.passKept(new RpcStub(new HiSink()))),
      });
    }
    if (path === "/object-keep") return Response.json(await env.OBJ.getByName("a").keep());
    if (path === "/object-use") return Response.json(await env.OBJ.getByName("a").use());
    if (path === "/make") {
      kept = new RpcStub(new Named());
      return Response.json(await kept.hi());
    }
    if (path === "/use") return Response.json(await attempt(() => kept.hi()));
    return Response.json(await attempt(() => new RpcStub(new Sink()).take(kept)));
  },
};
