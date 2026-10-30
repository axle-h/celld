// node:timers/promises and node:timers for Cells.
//
// Injected lazily into the generated stub module, so an isolate that never
// imports it pays nothing.
(() => {
  // workerd's node:timers/promises arms through node:timers' own timers,
  // which captured the globals' originals, so replacing the global
  // setTimeout does not reach it; these are celld's (harness.js).
  const { __setTimeout: setTimer, __clearTimeout: clearTimer } = __celld;
  const withSignal = (ms, value, options, schedule) =>
    new Promise((resolve, reject) => {
      const signal = options && options.signal;
      if (signal && signal.aborted) {
        reject(signal.reason);
        return;
      }
      let onAbort;
      const id = schedule(() => {
        if (signal && onAbort) signal.removeEventListener("abort", onAbort);
        resolve(value);
      }, Number(ms) || 0);
      if (signal) {
        onAbort = () => {
          clearTimer(id);
          reject(signal.reason);
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });

  const setTimeout_ = (ms, value, options) =>
    withSignal(ms, value, options, setTimer);

  const setImmediate_ = (value, options) =>
    withSignal(0, value, options, setTimer);

  // Yields once per interval until the caller stops iterating or aborts.
  async function* setInterval_(ms, value, options) {
    for (;;) {
      await setTimeout_(ms, undefined, options);
      yield value;
    }
  }

  // workerd's Scheduler here (internal_timers_promises.ts) refuses a
  // detached call, and its `wait` is the global `scheduler.wait`, so the two
  // validate and reject alike.
  const kScheduler = Symbol.for("kScheduler");
  const invalidThis = () => {
    const error = new TypeError('Value of "this" must be of type Scheduler');
    error.code = "ERR_INVALID_THIS";
    return error;
  };
  class Scheduler {
    [kScheduler] = true;

    yield() {
      if (!this[kScheduler]) throw invalidThis();
      return setImmediate_(undefined);
    }

    wait(delay, options) {
      if (!this[kScheduler]) throw invalidThis();
      return globalThis.scheduler.wait(delay, options);
    }
  }

  // Named, and of the lengths, workerd's are (internal_timers_promises.ts,
  // whose `options` parameters have defaults).
  const {
    ObjectCreate, ObjectDefineProperty, ObjectPreventExtensions, SymbolToStringTag,
  } = __celld.__intrinsics;
  const signature = (fn, name, length) => {
    ObjectDefineProperty(fn, "name", { __proto__: null, value: name });
    ObjectDefineProperty(fn, "length", { __proto__: null, value: length });
    return fn;
  };
  __celld.__timersPromises = {
    setTimeout: signature(setTimeout_, "setTimeout", 2),
    setImmediate: signature(setImmediate_, "setImmediate", 1),
    setInterval: signature(setInterval_, "setInterval", 2),
    scheduler: new Scheduler(),
  };

  // node:timers (workerd's timers.ts over internal_timers.ts): the timers
  // the harness makes once (`__nodeTimers`), which are the globals' under
  // enable_nodejs_global_timers. Its `promises` is workerd's internal
  // namespace of node:timers/promises, a module namespace of its own and
  // not the one an import of node:timers/promises gives: this object stands
  // in for it, with a namespace's prototype, tag, key order and attributes.
  const timers = __celld.__nodeTimers();
  const promises = ObjectCreate(null);
  const names = ["scheduler", "setImmediate", "setInterval", "setTimeout"];
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    ObjectDefineProperty(promises, name, {
      __proto__: null, value: __celld.__timersPromises[name], writable: true,
      enumerable: true, configurable: false,
    });
  }
  ObjectDefineProperty(promises, SymbolToStringTag, { __proto__: null, value: "Module" });
  ObjectPreventExtensions(promises);
  __celld.__timersModule = {
    Timeout: timers.Timeout,
    active: timers.active,
    clearImmediate: timers.clearImmediate,
    clearInterval: timers.clearInterval,
    clearTimeout: timers.clearTimeout,
    enroll: timers.enroll,
    promises,
    setImmediate: timers.setImmediate,
    setInterval: timers.setInterval,
    setTimeout: timers.setTimeout,
    unenroll: timers.unenroll,
  };
  __celld.__timersDefault = {
    promises,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    setImmediate: timers.setImmediate,
    clearImmediate: timers.clearImmediate,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
    active: timers.active,
    unenroll: timers.unenroll,
    enroll: timers.enroll,
  };
})();
