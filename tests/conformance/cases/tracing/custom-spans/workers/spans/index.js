// The custom-spans API of `tracing` (cloudflare:workers) and `ctx.tracing`,
// run with tracing on: the classes, the span lifecycle, the active span
// across awaits, the invocation span, and how arguments convert.
import { AsyncLocalStorage } from "node:async_hooks";
import { DurableObject, tracing } from "cloudflare:workers";

function attempt(use) {
  try {
    const value = use();
    return value === undefined ? "undefined" : value;
  } catch (error) {
    return `${error?.name}: ${error?.message}`;
  }
}

async function settle(promise) {
  try {
    return { value: await promise };
  } catch (error) {
    return { error: `${error?.name}: ${error?.message}` };
  }
}

function describe(object, key) {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (descriptor === undefined) return "absent";
  return Object.fromEntries(
    Object.entries(descriptor).map(([field, value]) => [field, typeof value === "function" ? "function" : String(value)]),
  );
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

// Module scope is outside any invocation.
const moduleScope = {
  activeSpan: String(tracing.getActiveSpan()),
  enterSpan: attempt(() =>
    tracing.enterSpan("module", (span) => ({ isTraced: span.isTraced, active: tracing.getActiveSpan() === span })),
  ),
  startSpan: attempt(() => tracing.startSpan("module").isTraced),
};

export class Traced extends DurableObject {
  async run() {
    const invocation = tracing.getActiveSpan();
    const inSpan = await tracing.enterSpan("in-object", async (span) => {
      await tick();
      return { active: tracing.getActiveSpan() === span, isTraced: span.isTraced };
    });
    return {
      stateHasTracing: "tracing" in this.ctx,
      invocation: typeof invocation,
      isTraced: invocation?.isTraced,
      stable: invocation === tracing.getActiveSpan(),
      inSpan,
    };
  }
}

const routes = {
  surface(ctx) {
    const tracingProto = Object.getPrototypeOf(tracing);
    const span = tracing.startSpan("surface");
    const spanProto = Object.getPrototypeOf(span);
    span.end();
    return {
      typeofTracing: typeof tracing,
      tracingTag: Object.prototype.toString.call(tracing),
      tracingConstructor: tracing.constructor.name,
      tracingOwnKeys: Reflect.ownKeys(tracing).map(String),
      tracingProto: Object.getOwnPropertyNames(tracingProto),
      tracingProtoParent: Object.getPrototypeOf(tracingProto) === Object.prototype,
      tracingMethod: describe(tracingProto, "enterSpan"),
      tracingSpan: describe(tracingProto, "Span"),
      tracingTagDescriptor: describe(tracingProto, Symbol.toStringTag),
      lengths: ["enterSpan", "startActiveSpan", "startSpan", "getActiveSpan"].map((name) => tracing[name].length),
      newTracing: attempt(() => new tracing.constructor()),
      spanClass: [typeof tracing.Span, tracing.Span.name, tracing.Span.length],
      newSpan: attempt(() => new tracing.Span()),
      subclassSpan: attempt(() => new (class extends tracing.Span {})()),
      spanTag: String(span),
      spanJson: JSON.stringify(span),
      spanKeys: Object.keys(span),
      spanProto: Object.getOwnPropertyNames(spanProto),
      spanProtoIsSpan: spanProto === tracing.Span.prototype,
      isTraced: describe(spanProto, "isTraced"),
      spanMethod: describe(spanProto, "setAttribute"),
      spanTagDescriptor: describe(spanProto, Symbol.toStringTag),
      spanLengths: ["setAttribute", "setAttributes", "recordException", "updateName", "setStatus", "end"].map(
        (name) => spanProto[name].length,
      ),
      illegal: {
        enterSpan: attempt(() => tracingProto.enterSpan.call({}, "x", () => 1)),
        getActiveSpan: attempt(() => tracingProto.getActiveSpan.call(undefined)),
        isTraced: attempt(() => describe(spanProto, "isTraced") && Object.getOwnPropertyDescriptor(spanProto, "isTraced").get.call({})),
        setAttribute: attempt(() => spanProto.setAttribute.call(tracing, "k", 1)),
        end: attempt(() => spanProto.end.call(null)),
      },
      ctxTracing: {
        descriptor: describe(ctx, "tracing"),
        sameAsModule: ctx.tracing === tracing,
        stable: ctx.tracing === ctx.tracing,
        sameClass: ctx.tracing.constructor === tracing.constructor && ctx.tracing.Span === tracing.Span,
        instance: tracing.startSpan("x") instanceof ctx.tracing.Span,
      },
    };
  },

  "module-scope"() {
    return moduleScope;
  },

  async "enter-span"() {
    let syncSpan;
    const sync = tracing.enterSpan(
      "sync",
      function (span, a, b) {
        syncSpan = span;
        return {
          args: [a, b, arguments.length],
          receiver: this === globalThis,
          isTraced: span.isTraced,
          active: tracing.getActiveSpan() === span,
        };
      },
      1,
      2,
    );
    const thrown = attempt(() =>
      tracing.enterSpan("throws", () => {
        throw new RangeError("sync failure");
      }),
    );
    const resolved = Promise.resolve("value");
    let asyncSpan;
    const returned = tracing.enterSpan("async", async (span) => {
      asyncSpan = span;
      await tick();
      return [tracing.getActiveSpan() === span, span.isTraced];
    });
    const passed = tracing.enterSpan("resolved", () => resolved);
    class Derived extends Promise {}
    const derived = tracing.enterSpan("derived", () => Derived.resolve("derived"));
    const thenable = { then(resolve) { resolve("thenable"); } };
    let nested;
    tracing.enterSpan("outer", (outer) => {
      tracing.enterSpan("inner", (inner) => {
        nested = { inner: tracing.getActiveSpan() === inner, distinct: inner !== outer };
      });
      nested.outerAgain = tracing.getActiveSpan() === outer;
    });
    return {
      sync,
      syncEnded: syncSpan.isTraced,
      thrown,
      returnsPromise: returned instanceof Promise,
      openWhilePending: asyncSpan.isTraced,
      async: await returned,
      asyncEnded: asyncSpan.isTraced,
      newPromise: passed !== resolved,
      resolved: await passed,
      derived: [derived instanceof Derived, derived.constructor.name, await derived],
      thenable: tracing.enterSpan("thenable", () => thenable) === thenable,
      rejected: await settle(tracing.enterSpan("rejects", async () => {
        await tick();
        throw new TypeError("async failure");
      })),
      nonError: attempt(() => tracing.enterSpan("throws-string", () => { throw "plain"; })),
      nested,
      afterwards: tracing.getActiveSpan() === tracing.getActiveSpan() && tracing.getActiveSpan() !== syncSpan,
    };
  },

  async "start-active-span"() {
    let span;
    const result = tracing.startActiveSpan("manual", (s, arg) => {
      span = s;
      return [arg, tracing.getActiveSpan() === s];
    }, "arg");
    const open = span.isTraced;
    span.end();
    const promise = Promise.resolve(1);
    let thrownSpan;
    const thrown = attempt(() => tracing.startActiveSpan("manual-throws", (s) => {
      thrownSpan = s;
      throw new Error("manual failure");
    }));
    const stillOpen = thrownSpan.isTraced;
    thrownSpan.end();
    let streamSpan;
    const stream = tracing.startActiveSpan("stream", (s) => {
      streamSpan = s;
      return new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("drained"));
          controller.close();
        },
      }).pipeThrough(new TransformStream({ flush() { s.end(); } }));
    });
    const beforeDrain = streamSpan.isTraced;
    const text = await new Response(stream).text();
    return {
      result,
      open,
      ended: span.isTraced,
      samePromise: tracing.startActiveSpan("manual-promise", (s) => { s.end(); return promise; }) === promise,
      thrown,
      stillOpen,
      stream: [beforeDrain, text, streamSpan.isTraced],
    };
  },

  "start-span"() {
    const invocation = tracing.getActiveSpan();
    const span = tracing.startSpan("detached");
    const notActive = tracing.getActiveSpan() === invocation;
    const open = span.isTraced;
    const chained = [
      span.setAttribute("k", "v") === span,
      span.setAttributes({ a: 1, b: true, c: "x", d: undefined }) === span,
      span.updateName("renamed") === span,
      span.setStatus({ code: "error", message: "failed" }) === span,
      span.recordException(new Error("recorded")),
    ];
    span.end();
    span.end();
    const afterEnd = [
      span.isTraced,
      span.setAttribute("k", "v") === span,
      span.updateName("late") === span,
      span.setStatus({ code: "ok" }) === span,
      String(span.recordException("late")),
    ];
    return { notActive, open, chained, afterEnd, longName: tracing.startSpan("n".repeat(1000)).isTraced };
  },

  async "active-span"(ctx) {
    const invocation = tracing.getActiveSpan();
    const storage = new AsyncLocalStorage();
    const out = {};
    await tracing.enterSpan("active", async (span) => {
      await tick();
      out.afterAwait = tracing.getActiveSpan() === span;
      out.inTimer = await new Promise((resolve) => setTimeout(() => resolve(tracing.getActiveSpan() === span), 1));
      out.withStore = storage.run("store", () => tracing.getActiveSpan() === span && storage.getStore() === "store");
      const snapshot = AsyncLocalStorage.snapshot();
      out.snapshot = snapshot;
    });
    out.restored = out.snapshot(() => tracing.getActiveSpan() !== invocation);
    delete out.snapshot;
    out.afterSpan = tracing.getActiveSpan() === invocation;
    out.inTimerOutside = await new Promise((resolve) => setTimeout(() => resolve(tracing.getActiveSpan() === invocation), 1));
    out.inWaitUntil = await new Promise((resolve) => {
      ctx.waitUntil((async () => {
        await tick();
        resolve(tracing.getActiveSpan() === invocation);
      })());
    });
    out.startSpanParent = tracing.enterSpan("parent", () => {
      const child = tracing.startSpan("child");
      const isTraced = child.isTraced;
      child.end();
      return isTraced;
    });
    return out;
  },

  "invocation-span"(ctx) {
    const invocation = tracing.getActiveSpan();
    const isTraced = invocation.isTraced;
    invocation.end();
    return {
      type: typeof invocation,
      isSpan: invocation instanceof tracing.Span,
      stable: invocation === tracing.getActiveSpan(),
      viaContext: invocation === ctx.tracing.getActiveSpan(),
      isTraced,
      afterEnd: invocation.isTraced,
      chained: [
        invocation.setAttribute("a", 1) === invocation,
        invocation.setAttributes({ b: "x" }) === invocation,
        invocation.updateName("renamed-invocation") === invocation,
        invocation.setStatus({ code: "ok" }) === invocation,
        String(invocation.recordException("noted")),
      ],
    };
  },

  conversion() {
    const span = tracing.startSpan("conversion");
    const result = {
      enterSpan: {
        noArguments: attempt(() => tracing.enterSpan()),
        noCallback: attempt(() => tracing.enterSpan("x")),
        notCallable: attempt(() => tracing.enterSpan("x", 5)),
        symbolName: attempt(() => tracing.enterSpan(Symbol("s"), () => 1)),
        nameFirst: attempt(() => tracing.enterSpan(Symbol("s"), 5)),
        objectName: attempt(() => tracing.enterSpan({ toString: () => "named" }, () => "ok")),
        undefinedName: attempt(() => tracing.enterSpan(undefined, () => "ok")),
      },
      startActiveSpan: attempt(() => tracing.startActiveSpan("x")),
      startSpan: [attempt(() => typeof tracing.startSpan()), attempt(() => tracing.startSpan(5).isTraced)],
      setAttribute: {
        noArguments: attempt(() => span.setAttribute()),
        keyOnly: attempt(() => span.setAttribute("k") === span),
        values: [null, {}, [1, 2], () => 1, "s", 1.5, false].map((value) => attempt(() => span.setAttribute("k", value) === span)),
        bigint: attempt(() => span.setAttribute("k", 1n)),
        symbol: attempt(() => span.setAttribute("k", Symbol("v"))),
        nullPrototype: attempt(() => span.setAttribute("k", Object.create(null))),
        symbolKey: attempt(() => span.setAttribute(Symbol("k"), 1)),
        objectKey: attempt(() => span.setAttribute({}, 1) === span),
      },
      setAttributes: {
        rejected: [undefined, null, "abc", [1, 2], 5].map((value) => attempt(() => span.setAttributes(value))),
        accepted: [() => 1, new Map([["a", 1]]), Object.create(null), Object.create({ inherited: 1 }), { [Symbol("k")]: 1 }].map(
          (value) => attempt(() => span.setAttributes(value) === span),
        ),
        noArguments: attempt(() => span.setAttributes()),
        badValue: attempt(() => span.setAttributes({ a: 1, b: 1n })),
        getters: attempt(() => {
          const read = [];
          span.setAttributes({ get a() { read.push("a"); return 1; }, get b() { read.push("b"); return undefined; } });
          return read;
        }),
      },
      setStatus: {
        noArguments: attempt(() => span.setStatus()),
        undefined: attempt(() => span.setStatus(undefined)),
        null: attempt(() => span.setStatus(null)),
        string: attempt(() => span.setStatus("ok")),
        empty: attempt(() => span.setStatus({})),
        badCode: attempt(() => span.setStatus({ code: "bad" })),
        array: attempt(() => span.setStatus([])),
        codeObject: attempt(() => span.setStatus({ code: { toString: () => "ok" } }) === span),
        symbolCode: attempt(() => span.setStatus({ code: Symbol("c") })),
        symbolMessage: attempt(() => span.setStatus({ code: "ok", message: Symbol("m") })),
        numberMessage: attempt(() => span.setStatus({ code: "error", message: 5 }) === span),
      },
      updateName: {
        noArguments: attempt(() => span.updateName()),
        symbol: attempt(() => span.updateName(Symbol("n"))),
        object: attempt(() => span.updateName({}) === span),
      },
      recordException: {
        noArguments: attempt(() => span.recordException()),
        values: ["text", new Error("e"), {}, 5, null, undefined, Object.create(null), { code: {} }].map((value) =>
          attempt(() => String(span.recordException(value))),
        ),
        bigintCode: attempt(() => span.recordException({ code: 1n })),
        symbolMessage: attempt(() => span.recordException({ message: Symbol("m") })),
      },
    };
    span.end();
    result.afterEnd = {
      bigint: attempt(() => span.setAttribute("k", 1n)),
      setAttributes: attempt(() => span.setAttributes(null)),
      badCode: attempt(() => span.setStatus({ code: "bad" })),
      recordException: attempt(() => String(span.recordException({ code: 1n }))),
    };
    return result;
  },

  // Worker code can replace globals and prototype methods. The runtime's own
  // use of tracing must not call them, or they could watch (or forge) what
  // it passes around.
  async "patched-globals"() {
    const seen = { arrayBuffers: 0, symbolKeys: 0, spans: 0, keys: 0, pushes: 0 };
    const saved = {
      Uint8Array: globalThis.Uint8Array,
      get: Map.prototype.get,
      set: Map.prototype.set,
      forEach: Map.prototype.forEach,
      keys: Object.keys,
      push: Array.prototype.push,
    };
    const note = (key, value) => {
      if (typeof key === "symbol") seen.symbolKeys++;
      if (value instanceof tracing.Span) seen.spans++;
    };
    globalThis.Uint8Array = function (...args) {
      if (args[0] instanceof ArrayBuffer) seen.arrayBuffers++;
      return new saved.Uint8Array(...args);
    };
    Map.prototype.get = function (key) {
      note(key);
      return saved.get.call(this, key);
    };
    Map.prototype.set = function (key, value) {
      note(key, value);
      return saved.set.call(this, key, value);
    };
    Map.prototype.forEach = function (callback, receiver) {
      return saved.forEach.call(this, (value, key, map) => {
        note(key, value);
        callback.call(receiver, value, key, map);
      });
    };
    Object.keys = function (object) {
      seen.keys++;
      return saved.keys(object);
    };
    Array.prototype.push = function (...items) {
      seen.pushes++;
      return saved.push.apply(this, items);
    };
    let result;
    try {
      // The invocation span, which outside any custom span comes from the
      // request's trace context.
      tracing.getActiveSpan().setAttribute("c", 3);
      result = await tracing.enterSpan("patched", async (span, arg) => {
        span.setAttributes({ a: 1 });
        const inner = tracing.startActiveSpan("inner", (s) => s);
        await null;
        const observed = [arg, span.isTraced, inner.isTraced, tracing.getActiveSpan() === span];
        inner.end();
        tracing.getActiveSpan().setAttribute("b", 2);
        tracing.startSpan("detached").end();
        return observed;
      }, "arg");
    } finally {
      globalThis.Uint8Array = saved.Uint8Array;
      Map.prototype.get = saved.get;
      Map.prototype.set = saved.set;
      Map.prototype.forEach = saved.forEach;
      Object.keys = saved.keys;
      Array.prototype.push = saved.push;
    }
    return { result, seen };
  },

  async "durable-object"(ctx, env) {
    return env.OBJECT.getByName("traced").run();
  },
};

export default {
  async fetch(request, env, ctx) {
    const route = routes[new URL(request.url).pathname.slice(1)];
    if (route === undefined) return new Response("not found", { status: 404 });
    return Response.json(await route(ctx, env));
  },
};
