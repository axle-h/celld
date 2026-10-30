// eval(), new Function() and compiling Wasm from bytes, as workerd allows
// them (io/worker.c++, jsg/setup.c++ modifyCodeGenCallback and
// allowWasmCallback): while the module evaluates, and the microtasks it
// queued, with allow_eval_during_startup (on from 2025-06-01), and never in
// a request or a Durable Object, its constructor included. V8 refuses them
// with an EvalError or a CompileError.
import { DurableObject } from "cloudflare:workers";

const WASM = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);

const attempt = (call) => {
  try {
    const value = call();
    return typeof value === "object" ? Object.prototype.toString.call(value) : value;
  } catch (error) {
    return `${error.constructor.name}: ${error.message}`;
  }
};
const settle = async (call) => {
  try {
    return Object.prototype.toString.call(await call());
  } catch (error) {
    return `${error.constructor.name}: ${error.message}`;
  }
};

// Strings only: eval() of a value that is not one is builtins/eval-non-string.
const sync = () => ({
  eval: attempt(() => eval("1 + 1")),
  indirectEval: attempt(() => (0, eval)("2 + 2")),
  globalEval: attempt(() => globalThis.eval("3")),
  newFunction: attempt(() => new Function("a", "return a * 2")(2)),
  callFunction: attempt(() => Function("return 5")()),
  emptyBody: attempt(() => typeof new Function("")),
  asyncFunction: attempt(() => typeof new (async function () {}).constructor("return 1")),
  generatorFunction: attempt(() => typeof new (function* () {}).constructor("yield 1")),
  wasmModule: attempt(() => new WebAssembly.Module(WASM)),
  wasmValidate: attempt(() => WebAssembly.validate(WASM)),
});
const async_ = async () => ({
  wasmCompile: await settle(() => WebAssembly.compile(WASM)),
  wasmInstantiate: await settle(() => WebAssembly.instantiate(WASM)),
});

const moduleScope = sync();
let microtask = null;
Promise.resolve().then(() => {
  microtask = attempt(() => eval("6"));
});

export class Probe extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.inConstructor = sync();
  }

  async probe() {
    return { constructor: this.inConstructor, method: sync(), ...(await async_()) };
  }
}

export default {
  async fetch(request, env) {
    const object = env.PROBE.get(env.PROBE.idFromName("probe"));
    return Response.json({
      reported: Cloudflare.compatibilityFlags.allow_eval_during_startup ?? null,
      moduleScope,
      microtask,
      request: { ...sync(), ...(await async_()) },
      durableObject: await object.probe(),
      // A promise settled in a request runs its continuation in one.
      later: await new Promise((resolve) => setTimeout(() => resolve(attempt(() => eval("7"))), 1)),
    });
  },
};
