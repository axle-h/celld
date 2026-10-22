// AsyncLocalStorage under `nodejs_als` (plan 1.16 classifies the flag as
// honoured), which Cloudflare.compatibilityFlags reports: a store follows its context across awaits, timers and promise
// callbacks, a nested run() shadows it and restores it, exit() hides it, and
// two concurrent runs keep their own stores.
import { AsyncLocalStorage } from "node:async_hooks";

const storage = new AsyncLocalStorage();
const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

async function trace(label) {
  const seen = [storage.getStore()];
  await tick();
  seen.push(storage.getStore());
  await Promise.resolve().then(() => seen.push(storage.getStore()));
  await new Promise((resolve) => setTimeout(() => resolve(seen.push(storage.getStore())), 1));
  return { label, seen };
}

export default {
  async fetch() {
    const outside = storage.getStore() ?? null;
    const run = await storage.run("outer", async () => {
      const before = await trace("outer");
      const nested = await storage.run("inner", () => trace("inner"));
      const after = storage.getStore();
      const exited = storage.exit(() => storage.getStore() ?? null);
      return { before, nested, after, exited };
    });
    const concurrent = await Promise.all(
      ["a", "b", "c"].map((name) => storage.run(name, () => trace(name))),
    );
    return Response.json({
      // Cloudflare.compatibilityFlags names the flag as enabled.
      reported: globalThis.Cloudflare.compatibilityFlags.nodejs_als ?? null,
      outside,
      run,
      concurrent,
      afterRuns: storage.getStore() ?? null,
    });
  },
};
