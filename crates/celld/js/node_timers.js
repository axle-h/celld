// node:timers/promises for Cells.
//
// Injected lazily into the generated stub module, so an isolate that never
// imports it pays nothing.
(() => {
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
          globalThis.clearTimeout(id);
          reject(signal.reason);
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });

  const setTimeout_ = (ms, value, options) =>
    withSignal(ms, value, options, globalThis.setTimeout);

  const setImmediate_ = (value, options) =>
    withSignal(0, value, options, globalThis.setTimeout);

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

  __celld.__timersPromises = {
    setTimeout: setTimeout_,
    setImmediate: setImmediate_,
    setInterval: setInterval_,
    scheduler: new Scheduler(),
  };
})();
