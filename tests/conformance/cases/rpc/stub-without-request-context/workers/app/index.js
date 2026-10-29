// Stubs a stateless Worker's handler makes belong to its request, and so do
// the stubs their targets make, keep, return and pass on: in workerd the
// request is one IoContext. Each RpcTarget here holds a stub made in the
// handler (`other`) or one it made in an earlier call (`made`), and uses,
// passes (duplicated, rpc_params_dup_stubs) and returns (transferred) it.
// `/keep` hands such a stub's target, from an entrypoint's call, a param it
// keeps with dup(); a later request can pass that on neither itself nor
// through the target (`/pass-kept`), since it belongs to `/keep`'s request.
import { RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";

const log = [];

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

async function attempt(fn) {
  try {
    return await fn();
  } catch (error) {
    return `${error.name}: ${error.message}`;
  }
}

class Named extends RpcTarget {
  constructor(name) {
    super();
    this.name = name;
  }
  hi() {
    return `hi ${this.name}`;
  }
  [Symbol.dispose]() {
    log.push(`dispose ${this.name}`);
  }
}

class Sink extends RpcTarget {
  take(stub) {
    return stub.hi();
  }
}

class Holder extends RpcTarget {
  constructor(other) {
    super();
    this.other = other;
  }
  callOther() {
    return this.other.hi();
  }
  passOther(sink) {
    return sink.take(this.other);
  }
  getOther() {
    return this.other;
  }
  make() {
    this.made = new RpcStub(new Named("made"));
    return "made";
  }
  passMade(sink) {
    return sink.take(this.made);
  }
  getMade() {
    return this.made;
  }
}

let kept;
let keeper;

class Keeper extends RpcTarget {
  keep(param) {
    kept = param.dup();
    return "kept";
  }
  passKept(sink) {
    return sink.take(kept);
  }
}

export class Entry extends WorkerEntrypoint {
  give(keeperStub) {
    return keeperStub.keep(new Named("given"));
  }
}

export default {
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    if (path === "/keep") {
      keeper = new RpcStub(new Keeper());
      return Response.json({
        give: await attempt(() => ctx.exports.Entry.give(keeper)),
        call: await attempt(() => kept.hi()),
      });
    }
    if (path === "/pass-kept") {
      return Response.json({
        pass: await attempt(() => new RpcStub(new Sink()).take(kept)),
        throughTarget: await attempt(() => keeper.passKept(new RpcStub(new Sink()))),
      });
    }
    const holder = new RpcStub(new Holder(new RpcStub(new Named("other"))));
    const sink = new RpcStub(new Sink());
    const out = {};
    out.callOther = await attempt(() => holder.callOther());
    out.passOther = await attempt(() => holder.passOther(sink));
    out.getOther = await attempt(async () => {
      const other = await holder.getOther();
      const hi = await other.hi();
      other[Symbol.dispose]();
      return hi;
    });
    // The return transferred it, so the holder's copy is gone.
    out.afterGetOther = await attempt(() => holder.callOther());
    out.make = await attempt(() => holder.make());
    out.passMade = await attempt(() => holder.passMade(sink));
    out.getMade = await attempt(async () => (await holder.getMade()).hi());
    await settle();
    out.log = log;
    return Response.json(out);
  },
};
