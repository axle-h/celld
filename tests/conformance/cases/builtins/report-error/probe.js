// reportError(error), as workerd's ServiceWorkerGlobalScope::reportError
// (api/global-scope.c++): an ErrorEvent on the global scope, made from V8's
// message for the value and not cancelable, then the console; it never
// throws. An exception an `error` listener throws meanwhile goes to the
// console, not to another event; it escapes reportError() only when the
// dispatch propagates it, without spec_compliant_dispatch_exceptions.
const attempt = (call) => {
  try {
    return { returned: call() ?? null };
  } catch (error) {
    return `${error.constructor.name}: ${error.message}`;
  }
};

const describe = (event) => ({
  type: event.type,
  constructor: event.constructor.name,
  message: event.message,
  lineno: typeof event.lineno,
  colno: typeof event.colno,
  filename: typeof event.filename,
  error: event.error instanceof Error ? `${event.error.name}: ${event.error.message}` : event.error ?? null,
  cancelable: event.cancelable,
  bubbles: event.bubbles,
  isTrusted: event.isTrusted,
});

export default {
  fetch(request, env) {
    if (new URL(request.url).pathname === "/spec" && env.SPEC) return env.SPEC.fetch(request);
    const events = [];
    const listener = (event) => {
      events.push(describe(event));
      event.preventDefault();
    };
    addEventListener("error", listener);
    const calls = {
      error: attempt(() => reportError(new TypeError("boom"))),
      string: attempt(() => reportError("text")),
      number: attempt(() => reportError(42)),
      undefined: attempt(() => reportError(undefined)),
      noArguments: attempt(() => reportError()),
      object: attempt(() => reportError({ stack: "custom stack" })),
    };
    removeEventListener("error", listener);

    // A listener that throws: its exception does not dispatch again.
    const nested = [];
    const thrower = (event) => {
      nested.push(event.error?.message ?? event.error);
      throw new Error("from listener");
    };
    addEventListener("error", thrower);
    const throwing = attempt(() => reportError(new Error("outer")));
    removeEventListener("error", thrower);

    // Without a listener it only logs.
    const unheard = attempt(() => reportError(new Error("unheard")));
    const detached = attempt(() => reportError.call(undefined, new Error("detached")));
    return Response.json({
      calls,
      events,
      throwing,
      nested,
      unheard,
      detached,
      name: reportError.name,
      length: reportError.length,
      enumerable: Object.keys(globalThis).includes("reportError"),
    });
  },
};
