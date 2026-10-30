// node:perf_hooks (workerd src/node/perf_hooks.ts), which resolves with
// nodejs_compat and enable_nodejs_perf_hooks_module: the Performance
// classes and `performance` are the globals, the Node.js extras are stubs,
// and its default export is an object of its own. Each Worker runs this
// under its own date and flags.
import * as perfHooks from "node:perf_hooks";
import perfHooksDefault, { performance as namedPerformance, constants } from "node:perf_hooks";

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
  const kind = typeof x.value === "function" ? `fn:${x.value.name}/${x.value.length}`
    : "value:" + typeof x.value;
  return kind + " " + (x.enumerable ? "e" : "") + (x.writable ? "w" : "") +
    (x.configurable ? "c" : "");
};
const keysOf = (o) => Reflect.ownKeys(o).map((k) => [String(k), descriptor(o, k)]);

export async function probe() {
  const errorOf = (f) => {
    try {
      f();
      return null;
    } catch (e) {
      return [describe(e), Object.keys(e), String(e), e instanceof Error,
        Object.getPrototypeOf(Object.getPrototypeOf(e.constructor.prototype)).constructor.name];
    }
  };
  const dynamic = await import("node:perf_hooks");
  return {
    flags: Object.fromEntries(["nodejs_compat", "enable_nodejs_perf_hooks_module"]
      .map((k) => [k, Cloudflare.compatibilityFlags[k] ?? null])),
    namespace: keysOf(perfHooks),
    default: keysOf(perfHooksDefault),
    defaultIsNamespaceMember: perfHooksDefault === perfHooks.default,
    globals: {
      performance: perfHooks.performance === globalThis.performance,
      named: namedPerformance === performance,
      defaultPerformance: perfHooksDefault.performance === performance,
      classes: ["Performance", "PerformanceEntry", "PerformanceMark", "PerformanceMeasure",
        "PerformanceObserver", "PerformanceObserverEntryList", "PerformanceResourceTiming"]
        .map((n) => [n, perfHooks[n] === globalThis[n], perfHooksDefault[n] === globalThis[n]]),
    },
    constants: [constants, Object.isFrozen(constants), constants === perfHooksDefault.constants],
    eventLoopUtilization: [perfHooks.eventLoopUtilization(), perfHooks.eventLoopUtilization(1, 2),
      Object.getPrototypeOf(perfHooks.eventLoopUtilization()) === Object.prototype,
      perfHooks.eventLoopUtilization === performance.eventLoopUtilization],
    timerify: t(() => {
      const f = () => 1;
      return [perfHooks.timerify(f) === f, perfHooks.timerify(5), perfHooks.timerify() ?? null,
        perfHooks.timerify === performance.timerify];
    }),
    createHistogram: errorOf(() => perfHooks.createHistogram()),
    monitorEventLoopDelay: errorOf(() => perfHooks.monitorEventLoopDelay()),
    dynamic: [Object.keys(dynamic), dynamic.default === perfHooksDefault,
      dynamic.performance === performance],
    bare: await import("perf_hooks").then((m) => [m.performance === performance,
      m.default === perfHooksDefault]),
    builtin: t(() => {
      const m = process.getBuiltinModule("node:perf_hooks");
      return [m === perfHooksDefault, Object.keys(m)];
    }),
  };
}
