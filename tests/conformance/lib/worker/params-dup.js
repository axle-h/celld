// The stub-ownership checks the rpc/params-dup* cases share. Each case's
// Worker re-exports this module's entrypoints and default handler, and sets
// the compatibility date and flags under test in its wrangler.jsonc.
//
// From compatibility date 2026-01-20 (`rpc_params_dup_stubs`, turned off by
// `rpc_params_transfer_stubs`), workerd duplicates a stub passed in a call's
// params instead of transferring it, and keeps transferring stubs in return
// values. An RpcTarget, function or Proxy param with its own `dup()` is
// replaced by what `dup()` returns, which must be the same kind
// (worker-rpc.c++ JsRpcTarget::serialize, serializeFunction and
// serializeProxy). Every call here stays in one isolate: through an RpcStub
// over a local RpcTarget, through `ctx.exports`, and from one Durable Object
// to another of the same class.
import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";

// What happened, in order: dup() calls, disposals, and the calls a target saw.
let log = [];

// Disposal runs after the call that releases the last stub returns, on both
// runtimes. Let it land before reading the log.
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

async function attempt(fn) {
  try {
    const value = await fn();
    return { type: typeof value, value: value ?? null };
  } catch (error) {
    return { error: `${error.name}: ${error.message}` };
  }
}

class Counter extends RpcTarget {
  constructor(name) {
    super();
    this.label = name;
    this.count = 0;
  }
  name() {
    return this.label;
  }
  inc() {
    this.count += 1;
    log.push(`inc ${this.label} ${this.count}`);
    return `${this.label}:${this.count}`;
  }
  [Symbol.dispose]() {
    log.push(`dispose ${this.label}`);
  }
}

// An RpcTarget whose dup() returns `make(this)`.
class Duplicable extends RpcTarget {
  constructor(name, make = (self) => new Duplicable(`${self.label}'`)) {
    super();
    this.label = name;
    this.make = make;
  }
  name() {
    return this.label;
  }
  dup() {
    log.push(`dup ${this.label}`);
    return this.make(this);
  }
  [Symbol.dispose]() {
    log.push(`dispose ${this.label}`);
  }
}

// A function whose dup() returns `make()`.
function duplicableFunction(name, make) {
  const fn = (x) => `${name}(${x})`;
  fn.dup = () => {
    log.push(`dup ${name}`);
    return make();
  };
  fn[Symbol.dispose] = () => log.push(`dispose ${name}`);
  return fn;
}

function disposableFunction(name) {
  const fn = (x) => `${name}(${x})`;
  fn[Symbol.dispose] = () => log.push(`dispose ${name}`);
  return fn;
}

// A Proxy that presents itself as an RpcTarget (by its prototype), answering
// `name`, `dup` and Symbol.dispose from its `get` trap.
function targetProxy(name, make) {
  return new Proxy(
    {},
    {
      getPrototypeOf: () => RpcTarget.prototype,
      get(_target, prop) {
        if (prop === "name") return () => name;
        if (prop === "dup" && make !== undefined) {
          return () => {
            log.push(`dup ${name}`);
            return make();
          };
        }
        if (prop === Symbol.dispose) return () => log.push(`dispose ${name}`);
        return undefined;
      },
    },
  );
}

// A Proxy that presents a plain object, as a Cap'n Web stub does: it crosses
// as a stub over its own properties (`name`), with a `dup` from its `get`
// trap.
function plainProxy(name, make) {
  const base = {
    name: () => name,
    [Symbol.dispose]: () => log.push(`dispose ${name}`),
  };
  return new Proxy(base, {
    get(target, prop) {
      if (prop === "dup" && make !== undefined) {
        return () => {
          log.push(`dup ${name}`);
          return make();
        };
      }
      return Reflect.get(target, prop);
    },
  });
}

// A Proxy over a function, with a `dup` from its `get` trap.
function functionProxy(name, make) {
  const base = (x) => `${name}(${x})`;
  base[Symbol.dispose] = () => log.push(`dispose ${name}`);
  return new Proxy(base, {
    get(target, prop) {
      if (prop === "dup") {
        return () => {
          log.push(`dup ${name}`);
          return make();
        };
      }
      return Reflect.get(target, prop);
    },
  });
}

// The receivers. `Backend` uses what it is given; `Relay` passes its params
// on to a Backend, as a proxy layer does.
class Backend extends RpcTarget {
  use(stub) {
    return stub.inc();
  }
  // A stub is callable whatever it points to, so the caller says whether to
  // call it or its name().
  name(value, callable) {
    return callable ? value("x") : value.name();
  }
  names(...values) {
    return Promise.all(values.map((value) => value.name()));
  }
  // Keeps the param itself, which the end of the call disposes.
  keep(stub) {
    this.kept = stub;
  }
  // Keeps a duplicate, which outlives the call.
  keepDup(stub) {
    this.kept = stub.dup();
  }
  useKept() {
    return this.kept.inc();
  }
  // The same RpcTarget twice in one return value.
  pair() {
    const target = new Counter("pair");
    return [target, target];
  }
  // Several stubs in one return value, which the caller disposes together.
  several() {
    return { a: new Counter("a"), b: new Counter("b"), c: new Counter("c") };
  }
}

class Relay extends RpcTarget {
  constructor(backend) {
    super();
    this.backend = backend;
  }
  async forwardTwice(stub) {
    const first = await attempt(() => this.backend.use(stub));
    const second = await attempt(() => this.backend.use(stub));
    return { first, second };
  }
  async forwardKeepDup(stub) {
    await this.backend.keepDup(stub);
  }
}

// A target that keeps a duplicate of its param and returns it, then tries to
// use it again.
class Holder extends RpcTarget {
  keepAndGive(stub) {
    this.held = stub.dup();
    return this.held;
  }
  useHeld() {
    return this.held.inc();
  }
}

export class BackendEntrypoint extends WorkerEntrypoint {
  use(stub) {
    return stub.inc();
  }
  name(value, callable) {
    return callable ? value("x") : value.name();
  }
}

export class RelayEntrypoint extends WorkerEntrypoint {
  async forwardTwice(stub) {
    const backend = this.ctx.exports.BackendEntrypoint;
    const first = await attempt(() => backend.use(stub));
    const second = await attempt(() => backend.use(stub));
    return { first, second };
  }
}

// One Durable Object passes its own stubs to another.
export class Peer extends DurableObject {
  use(stub) {
    return stub.inc();
  }
  names(...values) {
    return Promise.all(values.map((value) => value.name()));
  }
  async run() {
    log = [];
    const other = this.env.PEER.getByName("other");
    const counter = new RpcStub(new Counter("do"));
    const call = await attempt(() => other.use(counter));
    const reuse = await attempt(() => counter.inc());
    counter[Symbol.dispose]();
    await settle();
    const callLog = log;
    // The end of the call disposes its params last first.
    log = [];
    const names = await attempt(() =>
      other.names(new Counter("first"), new Counter("second"), new Counter("third")),
    );
    await settle();
    return { call, reuse, callLog, names, namesLog: log };
  }
}

function flags() {
  const read = (name) => {
    const value = globalThis.Cloudflare?.compatibilityFlags?.[name];
    return value === undefined ? "undefined" : value;
  };
  return {
    rpc_params_dup_stubs: read("rpc_params_dup_stubs"),
    rpc_params_transfer_stubs: read("rpc_params_transfer_stubs"),
  };
}

// The caller's own stub after passing it as a param: duplicated, it still
// works and the target lives until the caller disposes it; transferred, it is
// disposed by the call.
async function callerCopy(ctx) {
  const results = {};
  for (const [via, backend] of [
    ["rpcStub", new RpcStub(new Backend())],
    ["exports", ctx.exports.BackendEntrypoint],
  ]) {
    log = [];
    const counter = new RpcStub(new Counter(via));
    const call = await attempt(() => backend.use(counter));
    await settle();
    const afterCall = [...log];
    const reuse = await attempt(() => counter.inc());
    counter[Symbol.dispose]();
    await settle();
    results[via] = { call, afterCall, reuse, log };
  }
  return results;
}

// A proxy layer passing the same param on twice: the second call works only
// when the first one duplicated it.
async function proxyTwice(ctx) {
  log = [];
  const counter = new RpcStub(new Counter("twice"));
  const relay = new RpcStub(new Relay(new RpcStub(new Backend())));
  const rpcStub = await attempt(() => relay.forwardTwice(counter));
  await settle();
  const rpcStubLog = log;
  log = [];
  const counter2 = new RpcStub(new Counter("twice-exports"));
  const exports = await attempt(() => ctx.exports.RelayEntrypoint.forwardTwice(counter2));
  await settle();
  return { rpcStub, rpcStubLog, exports, exportsLog: log };
}

// A callee that keeps a param past the call: the param itself dies with the
// call, a dup() of it lives on, also behind a proxy layer.
async function keep() {
  log = [];
  const backend = new Backend();
  const backendStub = new RpcStub(backend);
  const counter = new RpcStub(new Counter("kept"));
  await backendStub.keep(counter);
  await settle();
  const param = await attempt(() => backendStub.useKept());
  const keptLog = log;

  log = [];
  const counter2 = new RpcStub(new Counter("kept-dup"));
  await backendStub.keepDup(counter2);
  await settle();
  const dup = await attempt(() => backendStub.useKept());
  const dupLog = log;

  log = [];
  const counter3 = new RpcStub(new Counter("kept-proxied"));
  const relay = new RpcStub(new Relay(backendStub));
  const forwarded = await attempt(() => relay.forwardKeepDup(counter3));
  await settle();
  const proxied = await attempt(() => backendStub.useKept());
  const caller = await attempt(() => counter3.inc());
  return { param, keptLog, dup, dupLog, forwarded, proxied, caller, proxiedLog: log };
}

// A stub in a return value still transfers: the callee's copy is disposed,
// while the param the caller passed is duplicated or transferred by the flag.
async function returned() {
  log = [];
  const holder = new RpcStub(new Holder());
  const counter = new RpcStub(new Counter("held"));
  const given = await holder.keepAndGive(counter);
  const use = await attempt(() => given.inc());
  const again = await attempt(() => holder.useHeld());
  const caller = await attempt(() => counter.inc());
  given[Symbol.dispose]();
  await settle();
  const afterGiven = [...log];
  counter[Symbol.dispose]();
  await settle();
  return { use, again, caller, afterGiven, log };
}

// A param with its own dup(): called (or not, with the flag off), and the
// call owns, and so disposes, whichever object it was given.
async function dupOverride(ctx) {
  const backend = new RpcStub(new Backend());
  const run = async (make, callable = false, via = backend) => {
    log = [];
    const result = await attempt(() => via.name(make(), callable));
    await settle();
    return { result, log };
  };
  return {
    rpcTarget: await run(() => new Duplicable("target")),
    rpcTargetExports: await run(
      () => new Duplicable("target-exports"),
      false,
      ctx.exports.BackendEntrypoint,
    ),
    function: await run(
      () => duplicableFunction("fn", () => disposableFunction("fn'")),
      true,
    ),
    targetProxy: await run(() => targetProxy("proxy", () => targetProxy("proxy'"))),
    // A Proxy RpcTarget may dup() to a plain RpcTarget: the same kind.
    targetProxyToTarget: await run(() => targetProxy("proxy", () => new Duplicable("plain'"))),
    functionProxy: await run(
      () => functionProxy("fproxy", () => disposableFunction("fproxy'")),
      true,
    ),
    // A function Proxy presents a callable plain object, so a plain object is
    // the same kind.
    functionProxyToPlain: await run(() =>
      functionProxy("fproxy", () => ({
        name: () => "plain'",
        [Symbol.dispose]: () => log.push("dispose plain'"),
      })),
    ),
    plainProxy: await run(() => plainProxy("pproxy", () => plainProxy("pproxy'"))),
    noDupPlainProxy: await run(() => plainProxy("pproxy")),
    // A Proxy presenting a plain object may dup() to a plain object or a
    // function: the same type to workerd.
    plainProxyToPlain: await run(() =>
      plainProxy("pproxy", () => ({
        name: () => "plain'",
        [Symbol.dispose]: () => log.push("dispose plain'"),
      })),
    ),
    plainProxyToFunction: await run(
      () => plainProxy("pproxy", () => disposableFunction("fn'")),
      true,
    ),
    // A `dup` that is not a function is not called.
    notFunction: await run(() => {
      const target = new Counter("value-dup");
      target.dup = 5;
      return target;
    }),
    // No dup(): the call takes the target itself.
    none: await run(() => new Counter("plain")),
    // The same target twice in one call is duplicated once.
    twice: await (async () => {
      log = [];
      const target = new Duplicable("both");
      const result = await attempt(() => backend.names(target, target));
      await settle();
      return { result, log };
    })(),
  };
}

// A dup() that returns another kind fails the call with workerd's
// DataCloneError, and so does one that throws. Whatever the call had already
// taken is released.
async function dupWrong() {
  const backend = new RpcStub(new Backend());
  const run = async (make, callable = false) => {
    log = [];
    const result = await attempt(() => backend.name(make(), callable));
    await settle();
    return { result, log };
  };
  return {
    targetToPlain: await run(() => new Duplicable("target", () => ({ name: () => "plain" }))),
    targetToFunction: await run(() => new Duplicable("target", () => () => "fn")),
    targetToProxy: await run(() => new Duplicable("target", () => targetProxy("proxy'"))),
    targetToPrimitive: await run(() => new Duplicable("target", () => "string")),
    functionToTarget: await run(() => duplicableFunction("fn", () => new Duplicable("target'"))),
    targetProxyToFunction: await run(() => targetProxy("proxy", () => disposableFunction("fn'"))),
    plainProxyToTarget: await run(() => plainProxy("pproxy", () => new Duplicable("target'"))),
    targetProxyToPlainProxy: await run(() => targetProxy("proxy", () => plainProxy("pproxy'"))),
    functionProxyToTarget: await run(() =>
      functionProxy("fproxy", () => new Duplicable("target'")),
    ),
    // An RpcProperty is callable but not a function to RPC.
    functionProxyToProperty: await run(() =>
      functionProxy("fproxy", () => new RpcStub(new Counter("property")).label),
    ),
    throws: await run(() =>
      new Duplicable("throws", () => {
        throw new Error("dup failed");
      }),
    ),
    // The second param fails after the first was duplicated and a third
    // target (with no dup()) was taken: both are released.
    partial: await (async () => {
      log = [];
      const good = new Duplicable("good");
      const taken = new Counter("taken");
      const bad = new Duplicable("bad", () => ({}));
      const result = await attempt(() => backend.names(good, taken, bad));
      await settle();
      return { result, log };
    })(),
    // A stub param ahead of the failure stays the caller's to use.
    stubBeforeFailure: await (async () => {
      log = [];
      const counter = new RpcStub(new Counter("stub"));
      const bad = new Duplicable("bad", () => ({}));
      const result = await attempt(() => backend.names(counter, bad));
      const reuse = await attempt(() => counter.inc());
      await settle();
      return { result, reuse, log };
    })(),
  };
}

// A call that fails on an unserializable param after a stub param: the stub
// is released as its ownership rule says (a transferred stub is disposed), and
// an RpcTarget the call had taken is disposed.
async function failedCall() {
  const backend = new RpcStub(new Backend());
  log = [];
  const counter = new RpcStub(new Counter("stub"));
  const result = await attempt(() => backend.names(counter, new (class Unsupported {})()));
  const reuse = await attempt(() => counter.inc());
  await settle();
  const stubLog = log;
  log = [];
  const result2 = await attempt(() =>
    backend.names(new Counter("taken"), new (class Unsupported {})()),
  );
  await settle();
  return { result, reuse, stubLog, result2, takenLog: log };
}

// Return values: the same RpcTarget twice arrives as one stub, and disposing
// a result disposes its stubs.
async function returns() {
  const backend = new RpcStub(new Backend());
  log = [];
  const pair = await backend.pair();
  const same = pair[0] === pair[1];
  const calls = [await attempt(() => pair[0].inc()), await attempt(() => pair[1].inc())];
  pair[0][Symbol.dispose]();
  await settle();
  const afterFirst = [...log];
  pair[1][Symbol.dispose]();
  await settle();
  const pairLog = log;
  log = [];
  const several = await backend.several();
  several[Symbol.dispose]();
  await settle();
  return { same, calls, afterFirst, pairLog, severalLog: log };
}

export default {
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    if (path === "/flags") return Response.json(flags());
    if (path === "/caller-copy") return Response.json(await callerCopy(ctx));
    if (path === "/proxy-twice") return Response.json(await proxyTwice(ctx));
    if (path === "/keep") return Response.json(await keep());
    if (path === "/returned") return Response.json(await returned());
    if (path === "/dup-override") return Response.json(await dupOverride(ctx));
    if (path === "/dup-wrong") return Response.json(await dupWrong());
    if (path === "/do-call") return Response.json(await env.PEER.getByName("caller").run());
    if (path === "/failed-call") return Response.json(await failedCall());
    if (path === "/returns") return Response.json(await returns());
    return new Response("not found", { status: 404 });
  },
};
