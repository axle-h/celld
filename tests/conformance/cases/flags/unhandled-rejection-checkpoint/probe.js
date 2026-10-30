// The global scope's unhandledrejection and rejectionhandled events. With
// unhandled_rejection_after_microtask_checkpoint a rejection is looked at
// once the microtask checkpoint completes, so a chain that handles it a few
// ticks later fires nothing; without it, the next microtask looks, and such a
// chain fires unhandledrejection, then rejectionhandled.
import { AsyncLocalStorage } from "node:async_hooks";

const log = [];
const als = new AsyncLocalStorage();
addEventListener("unhandledrejection", (event) => {
  log.push({
    type: event.type,
    class: event.constructor.name,
    reason: String(event.reason),
    promise: event.promise instanceof Promise,
    own: Object.keys(event),
    cancelable: event.cancelable,
    trusted: event.isTrusted,
    store: als.getStore() ?? null,
  });
});
addEventListener("rejectionhandled", (event) => {
  log.push({ type: event.type, reason: event.reason ?? null, promise: event.promise instanceof Promise });
});
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

async function run(name, scenario) {
  log.length = 0;
  await scenario();
  await tick();
  return [name, log.splice(0)];
}

export default {
  async fetch() {
    const results = [
      await run("plain", () => { Promise.reject("plain"); }),
      await run("multi-tick", async () => {
        const promise = Promise.reject("multi");
        await null;
        await null;
        await null;
        promise.catch(() => {});
      }),
      await run("late", async () => {
        const promise = Promise.reject("late");
        await tick();
        promise.catch(() => {});
      }),
      await run("handled", () => {
        Promise.reject("handled").catch(() => {});
      }),
      await run("microtask", () => {
        new Promise((_, reject) => queueMicrotask(() => reject("micro")));
      }),
      await run("context", () => {
        als.run("stored", () => { Promise.reject("context"); });
      }),
      await run("two", () => {
        Promise.reject("first");
        Promise.reject("second");
      }),
    ];
    let constructed;
    try {
      new PromiseRejectionEvent("unhandledrejection", {});
      constructed = "constructed";
    } catch (error) {
      constructed = `${error.name}: ${error.message}`;
    }
    return Response.json({
      results: Object.fromEntries(results),
      constructed,
      tag: Object.prototype.toString.call(PromiseRejectionEvent.prototype),
      reported: Cloudflare.compatibilityFlags.unhandled_rejection_after_microtask_checkpoint ?? null,
    });
  },
};
