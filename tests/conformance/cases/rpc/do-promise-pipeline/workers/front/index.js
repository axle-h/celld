// A Durable Object stub's method returns an RpcPromise, as workerd's does:
// properties of the result can be read before it is awaited, and the
// RpcPromise is disposable.
import { DurableObject, RpcPromise, RpcProperty, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";

// `undefined` does not survive JSON, so say what the value is as well.
async function attempt(fn) {
  try {
    const value = await fn();
    return { type: typeof value, value: value ?? null };
  } catch (error) {
    return { error: `${error.name}: ${error.message}` };
  }
}

export class Host extends DurableObject {
  getObj() {
    return { field: "value", inner: { deep: "deep" } };
  }

  fail() {
    throw new RangeError("deliberate failure");
  }

  async failLater() {
    await scheduler.wait(1);
    throw new TypeError("later failure");
  }

  fetch(request) {
    return new Response(`host fetch ${new URL(request.url).pathname}`);
  }
}

// Reads through the un-awaited result of a Durable Object call.
async function pipeline(env) {
  const host = env.HOST.getByName("pipeline");
  const pending = host.getObj();
  return {
    rpcPromise: pending instanceof RpcPromise,
    rpcProperty: pending.field instanceof RpcProperty,
    typeofCall: typeof pending,
    field: await attempt(() => pending.field),
    nested: await attempt(() => host.getObj().inner.deep),
    whole: await attempt(async () => (await host.getObj()).inner.deep),
    // The same RpcPromise read through again, then awaited.
    again: await attempt(() => pending.inner.deep),
    awaitedTwice: await attempt(async () => (await pending).field),
  };
}

// `.then`, `.catch` and `.finally` on an RpcPromise and an RpcProperty, and
// awaiting each.
async function thenables(env) {
  const host = env.HOST.getByName("thenables");
  const order = [];
  const promiseThen = await new Promise((resolve, reject) => host.getObj().then((value) => resolve(value.field), reject));
  const propertyThen = await new Promise((resolve, reject) => host.getObj().inner.deep.then(resolve, reject));
  const caught = await host.fail().catch((error) => `caught ${error.name}`);
  const propertyCaught = await host.fail().field.catch((error) => `caught ${error.name}`);
  const finished = await host.getObj().field.finally(() => order.push("finally"));
  const thenReturns = host.getObj().then((value) => value.field) instanceof Promise;
  return { promiseThen, propertyThen, caught, propertyCaught, finished, order, thenReturns };
}

// A failed call rejects every read through its result.
async function rejection(env) {
  const host = env.HOST.getByName("rejection");
  return {
    awaited: await attempt(() => host.fail()),
    field: await attempt(() => host.fail().field),
    nested: await attempt(() => host.fail().inner.deep),
    later: await attempt(() => host.failLater().inner.deep),
    call: await attempt(() => host.fail().method()),
  };
}

// A method's result is pipelined through a get-only Proxy over the
// un-awaited call, as Cloudflare OS's GatekeeperLoopback does.
const pipelineProxy = (session) =>
  new Proxy(session, {
    get(target, prop) {
      return Reflect.get(target, prop, target);
    },
    getPrototypeOf() {
      return WorkerEntrypoint.prototype;
    },
  });

export class Loopback extends WorkerEntrypoint {
  constructor(ctx, env) {
    super(ctx, env);
    return pipelineProxy(env.HOST.getByName("gatekeeper").getObj());
  }

  dummyMethod() {}
}

async function gatekeeper(env, ctx) {
  const local = pipelineProxy(env.HOST.getByName("gatekeeper").getObj());
  return {
    local: await attempt(() => local.inner.deep),
    field: await attempt(() => ctx.exports.Loopback.field),
    // workerd refuses a path through a Proxy member that is itself an
    // RpcProperty.
    nested: await attempt(() => ctx.exports.Loopback.inner.deep),
  };
}

// The stub's own members are not RPC calls. (`connect` is a function on
// both, though celld's is an RPC method.)
async function members(env) {
  const host = env.HOST.getByName("members");
  const response = await host.fetch("http://host/path");
  return {
    name: host.name,
    id: host.id.toString() === env.HOST.idFromName("members").toString(),
    then: typeof host.then,
    fetch: await response.text(),
    connect: typeof host.connect,
    method: typeof host.getObj,
  };
}

// A local RpcTarget whose result is a capability with a disposer.
class Tool extends RpcTarget {
  constructor(log) {
    super();
    this.log = log;
  }
  echo(value) {
    return `tool:${value}`;
  }
  [Symbol.dispose]() {
    this.log.push("tool disposed");
  }
}

class Maker extends RpcTarget {
  constructor(log) {
    super();
    this.log = log;
  }
  make() {
    return new Tool(this.log);
  }
  wrap() {
    return { tool: new Tool(this.log), label: "wrapped" };
  }
}

const settle = () => scheduler.wait(20);

// IlyaGulya's cloudflare-os-compat `/rpc-promise-dispose`.
export class EchoTool extends WorkerEntrypoint {
  async echo(value) {
    return `${this.ctx.props.prefix}:${value}`;
  }
}

// Disposing an RpcPromise refuses later pipelining through it but not
// awaiting it, and disposes its result: now if it has arrived, else on
// arrival.
async function dispose(env, ctx) {
  const host = env.HOST.getByName("dispose");
  const echo = ctx.exports.EchoTool({ props: { prefix: "rpc-promise" } });
  const echoPending = echo.echo("hello");
  const echoDisposable = typeof echoPending[Symbol.dispose] === "function";
  const echoResult = await echoPending;
  echoPending[Symbol.dispose]?.();

  // A Durable Object call's RpcPromise, disposed after its result arrived
  // and before.
  let held;
  let inside;
  {
    using pending = host.getObj();
    held = pending;
    inside = await attempt(() => pending.field);
  }
  const early = host.getObj();
  early[Symbol.dispose]();
  early[Symbol.dispose]();

  // The result a local RpcTarget returns carries a capability, so its
  // disposal is observable: the capability's stub is refused afterwards, and
  // its target's disposer runs.
  const log = [];
  const maker = new RpcStub(new Maker(log));
  let tool;
  {
    using made = maker.make();
    tool = await made;
    log.push(`inside: ${await tool.echo("a")}`);
  }
  const afterUsing = await attempt(() => tool.echo("b"));
  await settle();
  const pendingMade = maker.make();
  pendingMade[Symbol.dispose]();
  const disposedOnArrival = await pendingMade;
  const arrivalEcho = await attempt(() => disposedOnArrival.echo("c"));
  await settle();
  const wrapped = maker.wrap();
  const wrappedValue = await wrapped;
  wrapped[Symbol.dispose]();
  const wrappedEcho = await attempt(() => wrappedValue.tool.echo("d"));
  await settle();
  maker[Symbol.dispose]();

  return {
    echo: { result: echoResult, disposable: echoDisposable },
    doDisposable: typeof host.getObj()[Symbol.dispose],
    propertyDisposable: typeof host.getObj().field[Symbol.dispose],
    inside,
    awaitAfter: await attempt(async () => (await held).field),
    fieldAfter: await attempt(() => held.field),
    nestedAfter: await attempt(() => held.inner.deep),
    callAfter: await attempt(() => held.method()),
    earlyAwait: await attempt(async () => (await early).field),
    earlyField: await attempt(() => early.field),
    afterUsing,
    arrivalEcho,
    wrappedEcho,
    wrappedLabel: wrappedValue.label,
    log,
  };
}

// A rejected call's RpcPromise, disposed after and before it rejected, and
// an RpcProperty read before and after its RpcPromise is disposed.
async function disposeSettled(env) {
  const host = env.HOST.getByName("dispose-settled");
  const failed = host.fail();
  const beforeDispose = await attempt(() => failed);
  failed[Symbol.dispose]();
  const early = host.fail();
  early[Symbol.dispose]();

  const pending = host.getObj();
  const property = pending.field;
  const propertyBefore = await attempt(() => property);
  pending[Symbol.dispose]();
  return {
    beforeDispose,
    awaitAfter: await attempt(() => failed),
    fieldAfter: await attempt(() => failed.field),
    earlyAwait: await attempt(() => early),
    earlyField: await attempt(() => early.field),
    propertyBefore,
    propertyAfter: await attempt(() => property),
    propertyThenAfter: await attempt(() => new Promise((resolve, reject) => property.then(resolve, reject))),
  };
}

// How an RpcPromise and an RpcProperty answer introspection.
function describe(fn) {
  try {
    return fn();
  } catch (error) {
    return `${error.name}: ${error.message}`;
  }
}

async function introspection(env) {
  const host = env.HOST.getByName("introspection");
  const pending = host.getObj();
  const other = host.getObj();
  const property = pending.field;
  const disposer = RpcPromise.prototype[Symbol.dispose];
  const result = {
    protoDispose: typeof disposer,
    shared: pending[Symbol.dispose] === other[Symbol.dispose],
    fromProto: pending[Symbol.dispose] === disposer,
    ownDispose: Object.hasOwn(pending, Symbol.dispose),
    hasDispose: Symbol.dispose in pending,
    hasThen: "then" in pending,
    hasCatch: "catch" in pending,
    hasField: "field" in pending,
    hasIterator: Symbol.iterator in pending,
    propertyHasDispose: Symbol.dispose in property,
    propertyHasThen: "then" in property,
    propertyHasField: "inner" in property,
    propertyProtoDispose: typeof RpcProperty.prototype[Symbol.dispose],
    wrongReceiver: describe(() => disposer.call({})),
    propertyReceiver: describe(() => disposer.call(property)),
    noReceiver: describe(() => disposer.call(undefined)),
  };
  await pending;
  await other;
  return result;
}

export default {
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    // IlyaGulya's cloudflare-os-compat `/do-return-rpc-pipeline` returns an
    // RpcTarget across isolates, so it is in `rpc/do-return-rpc-pipeline`.
    if (path === "/pipeline") return Response.json(await pipeline(env));
    if (path === "/thenables") return Response.json(await thenables(env));
    if (path === "/rejection") return Response.json(await rejection(env));
    if (path === "/gatekeeper") return Response.json(await gatekeeper(env, ctx));
    if (path === "/members") return Response.json(await members(env));
    if (path === "/dispose-settled") return Response.json(await disposeSettled(env));
    if (path === "/introspection") return Response.json(await introspection(env));
    if (path === "/dispose") return Response.json(await dispose(env, ctx));
    return new Response("not found", { status: 404 });
  },
};
