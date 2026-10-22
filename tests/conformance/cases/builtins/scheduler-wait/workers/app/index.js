// `scheduler.wait(ms, { signal })`, on the global and through
// `node:timers/promises`, which delegates to it: a wait resolves with
// undefined, an abort rejects it with the signal's own reason (an
// already-aborted signal at once), an abort after it settled changes nothing,
// and arguments workerd refuses are refused with its error. workerd rejects
// with a copy of the reason rebuilt from its name and message, where celld
// rejects with the reason itself, so the case compares names and messages
// and uses only Error reasons (a string reason arrives as an Error there).
import { scheduler as nodeScheduler } from "node:timers/promises";

const describe = (value) =>
  value instanceof Error || value instanceof DOMException
    ? { name: value.name, message: value.message, code: value.code ?? null }
    : value;

async function outcome(promise) {
  try {
    return { resolved: (await promise) ?? null };
  } catch (error) {
    return { rejected: describe(error) };
  }
}

function attempt(fn) {
  try {
    return outcome(fn());
  } catch (error) {
    return { threw: describe(error) };
  }
}

async function suite(target) {
  const wait = (...args) => target.wait(...args);
  const result = {};
  result.plain = await outcome(wait(1));
  result.noOptions = await outcome(wait(1, undefined));
  result.emptyOptions = await outcome(wait(1, {}));
  result.unknownOption = await outcome(wait(1, { priority: "user-blocking" }));
  result.undefinedSignal = await outcome(wait(1, { signal: undefined }));
  result.unabortedSignal = await outcome(wait(1, { signal: new AbortController().signal }));

  // Already aborted: rejects with the reason without waiting for the delay.
  {
    const reason = new Error("before");
    const started = Date.now();
    result.preAborted = await outcome(wait(60_000, { signal: AbortSignal.abort(reason) }));
    result.preAbortedPrompt = Date.now() - started < 30_000;
  }
  result.preAbortedDefault = await outcome(wait(60_000, { signal: AbortSignal.abort() }));
  {
    const controller = new AbortController();
    controller.abort();
    result.preAbortedController = await outcome(wait(60_000, { signal: controller.signal }));
  }

  // Aborted while waiting: rejects then, long before the delay.
  {
    const controller = new AbortController();
    const reason = new RangeError("during");
    const started = Date.now();
    setTimeout(() => controller.abort(reason), 5);
    result.abortedDuring = await outcome(wait(60_000, { signal: controller.signal }));
    result.abortedDuringPrompt = Date.now() - started < 30_000;
  }
  result.timeoutSignal = await outcome(wait(60_000, { signal: AbortSignal.timeout(5) }));
  {
    const first = new AbortController();
    const second = new AbortController();
    const signal = AbortSignal.any([first.signal, second.signal]);
    setTimeout(() => second.abort(new TypeError("any")), 5);
    result.anySignal = await outcome(wait(60_000, { signal }));
    result.anyPreAborted = await outcome(
      wait(60_000, { signal: AbortSignal.any([first.signal, AbortSignal.abort(new Error("pre"))]) }));
  }

  // Aborted after it resolved: the wait stays resolved.
  {
    const controller = new AbortController();
    const settled = await outcome(wait(1, { signal: controller.signal }));
    controller.abort(new Error("late"));
    result.abortedAfter = settled;
  }

  // One signal shared by two waits rejects both with the same reason.
  {
    const controller = new AbortController();
    const reason = new Error("shared");
    const both = Promise.all([
      outcome(wait(60_000, { signal: controller.signal })),
      outcome(wait(60_000, { signal: controller.signal })),
    ]);
    setTimeout(() => controller.abort(reason), 5);
    result.shared = await both;
  }

  result.invalid = {
    signalNotAbortSignal: await attempt(() => wait(1, { signal: {} })),
    signalNull: await attempt(() => wait(1, { signal: null })),
    optionsNull: await attempt(() => wait(1, null)),
    optionsString: await attempt(() => wait(1, "fast")),
    delayString: await attempt(() => wait("1")),
    delayNotNumeric: await attempt(() => wait("soon")),
    delayObject: await attempt(() => wait({ valueOf: () => 1 })),
    delayUndefined: await attempt(() => wait(undefined)),
    delayMissing: await attempt(() => wait()),
    delayNaN: await attempt(() => wait(NaN)),
    delayNegative: await attempt(() => wait(-5)),
  };
  return result;
}

export default {
  async fetch() {
    return Response.json({
      global: {
        keys: Object.keys(Object.getPrototypeOf(scheduler)).concat(Object.keys(scheduler)).sort(),
        yield: typeof scheduler.yield,
        ...(await suite(scheduler)),
      },
      nodeTimersPromises: {
        yield: await outcome(nodeScheduler.yield()),
        detachedWait: await attempt(() => nodeScheduler.wait.call(undefined, 1)),
        detachedYield: await attempt(() => nodeScheduler.yield.call({})),
        ...(await suite(nodeScheduler)),
      },
    });
  },
};
