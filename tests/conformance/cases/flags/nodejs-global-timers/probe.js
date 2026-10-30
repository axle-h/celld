// The global timers under enable_nodejs_global_timers, which nodejs_compat
// implies from 2026-02-10: setTimeout and setInterval return Node.js Timeout
// objects, and clearTimeout and clearInterval take them.
const wait = (ms) => new Promise((resolve) => scheduler.wait(ms).then(resolve));
const describe = (error) => `${error.name}: ${error.message}${error.code ? ` (${error.code})` : ""}`;

function shape(timer) {
  if (typeof timer !== "object" || timer === null) return typeof timer;
  const prototype = Object.getPrototypeOf(timer);
  return {
    constructor: prototype.constructor.name,
    tag: Object.prototype.toString.call(timer),
    methods: Reflect.ownKeys(prototype).map(String).sort(),
    own: Reflect.ownKeys(timer).map(String),
    primitive: typeof +timer,
  };
}

export default {
  async fetch() {
    const fired = [];
    const timeout = setTimeout((...args) => fired.push(["timeout", ...args]), 1, "a", "b");
    const cleared = setTimeout(() => fired.push(["cleared"]), 1);
    clearTimeout(cleared);
    const byNumber = setTimeout(() => fired.push(["byNumber"]), 1);
    clearTimeout(+byNumber);
    let ticks = 0;
    // A callback's `this`, which is the global scope under either flag.
    const receivers = [];
    const receiver = (self) => self === globalThis ? "globalThis" : String(self);
    setTimeout(function () { receivers.push(receiver(this)); }, 1);
    const interval = setInterval(function () {
      if (ticks === 0) receivers.push(receiver(this));
      ticks++;
      if (ticks === 2) clearInterval(interval);
    }, 1);
    await wait(30);
    const result = {
      timeout: shape(timeout),
      interval: shape(interval),
      fired,
      ticks,
      receivers,
      functions: {
        setTimeout: [setTimeout.name, setTimeout.length],
        setInterval: [setInterval.name, setInterval.length],
        clearTimeout: [clearTimeout.name, clearTimeout.length],
        clearInterval: [clearInterval.name, clearInterval.length],
      },
    };
    if (typeof timeout === "object") {
      const refs = [timeout.hasRef()];
      refs.push(timeout.unref() === timeout, timeout.hasRef());
      refs.push(timeout.ref() === timeout, timeout.hasRef());
      result.refs = refs;
      let refreshed = 0;
      const again = setTimeout(() => refreshed++, 5);
      await wait(2);
      result.refreshReturns = again.refresh() === again;
      await wait(30);
      result.refreshed = refreshed;
      let closed = 0;
      const closing = setTimeout(() => closed++, 1);
      result.closeReturns = closing.close() === closing;
      let disposed = 0;
      setTimeout(() => disposed++, 1)[Symbol.dispose]();
      await wait(10);
      result.closed = closed;
      result.disposed = disposed;
    }
    for (const [name, call] of [
      ["string", () => setTimeout("1 + 1", 1)],
      ["missing", () => setTimeout()],
      ["intervalString", () => setInterval("x", 1)],
      ["nullPrototype", () => setTimeout(Object.assign(Object.create(null), { a: 1 }), 1)],
      ["emptyNullPrototype", () => setTimeout(Object.create(null), 1)],
      ["anonymousClass", () => setTimeout(new (class {})(), 1)],
      ["constructorField", () => setTimeout({ constructor: 5 }, 1)],
      ["symbolKeyed", () => setTimeout(Object.assign(Object.create(null), { [Symbol("s")]: 1 }), 1)],
      ["tagged", () => setTimeout(new (class { get [Symbol.toStringTag]() { return "Tagged"; } })(), 1)],
      ["taggedNullPrototype", () => setTimeout(Object.create(Object.create(null, { [Symbol.toStringTag]: { value: "T" } })), 1)],
      ["ownTag", () => setTimeout(Object.assign(Object.create(null), { [Symbol.toStringTag]: "Own" }), 1)],
    ]) {
      try {
        const timer = call();
        clearTimeout(timer);
        clearInterval(timer);
        result[name] = typeof timer;
      } catch (error) {
        result[name] = describe(error);
      }
    }
    result.reported = Cloudflare.compatibilityFlags.enable_nodejs_global_timers ?? null;
    return Response.json(result);
  },
};
