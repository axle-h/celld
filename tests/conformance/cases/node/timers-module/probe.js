// node:timers (workerd src/node/timers.ts over internal_timers.ts): its
// Timeout and timer functions, which are the global ones under
// enable_nodejs_global_timers, setImmediate and clearImmediate bound from
// node-internal:timers with their Immediate objects, `promises` as a module
// namespace other than the one node:timers/promises imports to, and its
// default export, an object of its own. Each Worker runs this under its own
// date and flags.
//
// Left out: whether import() gives the static import's namespace
// (node/dynamic-import-namespace).
import * as timers from "node:timers";
import timersDefault, { setTimeout as namedSetTimeout, Timeout } from "node:timers";
import * as promisesNamespace from "node:timers/promises";

const describe = (e) => (e && typeof e === "object" && "message" in e)
  ? `${e.constructor?.name}/${e.name}/${e.code}: ${e.message}` : String(e);
const t = (f) => {
  try {
    const value = f();
    return value === undefined ? "undefined" : value;
  } catch (e) {
    return "threw " + describe(e);
  }
};
const descriptor = (o, k) => {
  const x = Object.getOwnPropertyDescriptor(o, k);
  if (!x) return null;
  const out = [];
  if ("value" in x) {
    out.push(typeof x.value === "function" ? `fn:${x.value.name}/${x.value.length}`
      : "value:" + typeof x.value);
  }
  if (x.get) out.push(`get:${JSON.stringify(x.get.name)}`);
  out.push((x.enumerable ? "e" : "") + (x.writable ? "w" : "") + (x.configurable ? "c" : ""));
  return out.join(" ");
};
const INTERNAL = /cloudflare:internal-class|kResourceTypeInspect/;
const keysOf = (o) => Reflect.ownKeys(o).filter((k) => !INTERNAL.test(String(k)))
  .map((k) => [String(k), descriptor(o, k)]);
// Whether `fn`, a callback scheduled with `schedule`, has run once `wait`
// milliseconds of other timers have passed.
const ran = (schedule, wait = 20) => new Promise((resolve) => {
  let fired = false;
  schedule(() => { fired = true; });
  globalThis.setTimeout(() => resolve(fired), wait);
});

export async function probe() {
  const out = {};
  out.flags = Object.fromEntries(["nodejs_compat", "enable_nodejs_global_timers"]
    .map((k) => [k, Cloudflare.compatibilityFlags[k] ?? null]));
  out.namespace = keysOf(timers);
  out.namespaceTag = Object.prototype.toString.call(timers);
  out.default = keysOf(timersDefault);
  out.defaultPrototype = Object.getPrototypeOf(timersDefault) === Object.prototype;
  out.defaultIsNamespaceMember = timersDefault === timers.default;
  out.named = namedSetTimeout === timers.setTimeout;
  out.sameAsGlobal = {
    setTimeout: timers.setTimeout === globalThis.setTimeout,
    clearTimeout: timers.clearTimeout === globalThis.clearTimeout,
    setInterval: timers.setInterval === globalThis.setInterval,
    clearInterval: timers.clearInterval === globalThis.clearInterval,
    defaultSetTimeout: timersDefault.setTimeout === timers.setTimeout,
    defaultSetImmediate: timersDefault.setImmediate === timers.setImmediate,
  };
  out.promises = {
    imported: timers.promises === promisesNamespace,
    default: timersDefault.promises === timers.promises,
    tag: Object.prototype.toString.call(timers.promises),
    prototype: Object.getPrototypeOf(timers.promises),
    keys: keysOf(timers.promises),
    extensible: Object.isExtensible(timers.promises),
    members: ["setTimeout", "setImmediate", "setInterval", "scheduler"]
      .map((k) => timers.promises[k] === promisesNamespace[k]),
  };
  out.timeoutClass = {
    name: Timeout.name,
    length: Timeout.length,
    prototype: keysOf(Timeout.prototype),
    statics: keysOf(Timeout),
    fromGlobal: (() => {
      const g = globalThis.setTimeout(() => {}, 1000);
      const result = [typeof g, g instanceof Timeout];
      globalThis.clearTimeout(g);
      return result;
    })(),
  };
  const timeout = timers.setTimeout(() => {}, 100000);
  out.timeout = {
    tag: Object.prototype.toString.call(timeout),
    own: keysOf(timeout),
    instance: timeout instanceof Timeout,
    primitive: typeof +timeout,
    hasRef: timeout.hasRef(),
    unref: timeout.unref() === timeout,
    hasRefAfterUnref: timeout.hasRef(),
    ref: timeout.ref() === timeout,
    refresh: timeout.refresh() === timeout,
    close: timeout.close() === timeout,
  };
  out.fires = await new Promise((resolve) => {
    timers.setTimeout((a, b) => resolve([a, b]), 1, "x", "y");
  });
  out.cleared = {
    timeout: await ran((f) => timers.clearTimeout(timers.setTimeout(f, 1))),
    number: await ran((f) => timers.clearTimeout(+timers.setTimeout(f, 1))),
    string: await ran((f) => timers.clearTimeout(String(+timers.setTimeout(f, 1)))),
    unenroll: await ran((f) => timers.unenroll(timers.setTimeout(f, 1))),
  };
  out.interval = await new Promise((resolve) => {
    let n = 0;
    const x = timers.setInterval(() => {
      if (++n === 3) {
        timers.clearInterval(x);
        resolve(n);
      }
    }, 1);
  });
  out.active = [t(() => timers.active(5)), await new Promise((resolve) => {
    let fired = 0;
    timers.active(timers.setTimeout(() => { fired++; }, 1));
    globalThis.setTimeout(() => resolve(fired), 30);
  })];
  out.enroll = t(() => timers.enroll({}, 5));
  out.badCallbacks = [undefined, null, 5, "s", {}, [], Symbol("q")]
    .map((v) => t(() => timers.setTimeout(v)));
  out.badInterval = t(() => timers.setInterval());
  out.delayString = t(() => {
    const x = timers.setTimeout(() => {}, "5");
    const kind = typeof +x;
    x.close();
    return kind;
  });
  out.functions = Object.fromEntries(Object.keys(timers)
    .filter((k) => typeof timers[k] === "function")
    .map((k) => [k, [timers[k].name, timers[k].length]]));

  out.immediate = await new Promise((resolve) => {
    const immediate = timers.setImmediate((a, b) => resolve([a, b, typeof immediate,
      Object.prototype.toString.call(immediate)]), "i", "j");
  });
  const immediate = timers.setImmediate(() => {});
  timers.clearImmediate(immediate);
  const Immediate = immediate.constructor;
  out.immediateClass = {
    name: Immediate.name,
    length: Immediate.length,
    prototype: keysOf(Immediate.prototype),
    own: keysOf(immediate),
    construct: t(() => new Immediate()),
    call: t(() => Immediate()),
    hasRef: immediate.hasRef(),
    ref: t(() => immediate.ref()),
    unref: t(() => immediate.unref()),
    other: t(() => Immediate.prototype.hasRef.call({})),
  };
  out.immediateCleared = {
    clear: await ran((f) => timers.clearImmediate(timers.setImmediate(f))),
    dispose: await ran((f) => timers.setImmediate(f)[Symbol.dispose]()),
    undefined: t(() => timers.clearImmediate(undefined)),
    null: t(() => timers.clearImmediate(null)),
    none: t(() => timers.clearImmediate()),
    number: t(() => timers.clearImmediate(5)),
    object: t(() => timers.clearImmediate({})),
  };
  out.immediateArguments = [t(() => timers.setImmediate(5)), t(() => timers.setImmediate())];
  out.dynamic = await import("node:timers").then((m) => [m.default === timersDefault,
    m.setTimeout === timers.setTimeout, Object.keys(m)]);
  out.bare = await import("timers").then((m) => [m.setTimeout === timers.setTimeout,
    m.default === timersDefault]);
  out.builtin = t(() => {
    const m = process.getBuiltinModule("node:timers");
    return [m === timersDefault, Object.keys(m)];
  });
  return out;
}
