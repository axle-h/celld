// What a listener's exception does to a dispatch. With
// spec_compliant_dispatch_exceptions it is reported (an ErrorEvent on the
// global scope, then the console) and the remaining listeners run; without
// it, the first exception ends the dispatch and propagates.
const errors = [];
addEventListener("error", (event) => {
  errors.push({
    type: event.constructor.name,
    message: event.message,
    error: event.error instanceof Error ? event.error.message : String(event.error),
    cancelable: event.cancelable,
  });
  if (event.error?.message === "prevented") event.preventDefault();
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

async function run(action) {
  const log = [];
  errors.length = 0;
  let outcome;
  try {
    outcome = { returned: await action(log) };
  } catch (error) {
    outcome = { threw: `${error.name}: ${error.message}` };
  }
  await settle();
  return { log, ...outcome, errors: errors.splice(0) };
}

function listeners(target, type, log) {
  target.addEventListener(type, () => log.push("first"));
  target.addEventListener(type, () => {
    log.push("second");
    throw new Error("second failed");
  });
  target.addEventListener(type, () => {
    log.push("third");
    throw new TypeError("third failed");
  });
}

export default {
  async fetch() {
    return Response.json({
      dispatch: await run((log) => {
        const target = new EventTarget();
        listeners(target, "ping", log);
        return target.dispatchEvent(new Event("ping", { cancelable: true }));
      }),
      handler: await run((log) => {
        const target = new EventTarget();
        target.addEventListener("ping", () => {
          log.push("listener");
          throw new Error("prevented");
        });
        target.addEventListener("ping", () => log.push("after"));
        return target.dispatchEvent(new Event("ping"));
      }),
      abort: await run((log) => {
        const controller = new AbortController();
        listeners(controller.signal, "abort", log);
        controller.signal.onabort = () => log.push("onabort");
        controller.abort("why");
        return controller.signal.aborted;
      }),
      timeout: await run(async (log) => {
        const signal = AbortSignal.any([AbortSignal.timeout(1)]);
        listeners(signal, "abort", log);
        await new Promise((resolve) => setTimeout(resolve, 30));
        return signal.aborted;
      }),
      message: await run(async (log) => {
        const { port1, port2 } = new MessageChannel();
        port1.addEventListener("message", (event) => {
          log.push(`first ${event.data}`);
          throw new Error("port failed");
        });
        port1.addEventListener("message", (event) =>
          log.push(`second ${event.data instanceof Error ? event.data.message : event.data}`));
        port1.addEventListener("messageerror", (event) => log.push(`messageerror ${event.data?.message}`));
        port1.start();
        port2.postMessage("hello");
        await new Promise((resolve) => setTimeout(resolve, 20));
        return "sent";
      }),
      reported: Cloudflare.compatibilityFlags.spec_compliant_dispatch_exceptions ?? null,
    });
  },
};
