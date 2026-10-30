// bind_asynclocalstorage_snapshot_to_request: a function that
// AsyncLocalStorage.bind() or snapshot() or an AsyncResource made in one
// request throws when called in another with the flag; without it, it runs.
// One made at module scope runs anywhere.
import { AsyncLocalStorage, AsyncResource } from "node:async_hooks";

const als = new AsyncLocalStorage();
const read = () => als.getStore() ?? "none";
const made = {};
const make = (scope) => {
  made[`${scope} bind`] = AsyncLocalStorage.bind(read);
  made[`${scope} bind in run`] = als.run("stored", () => AsyncLocalStorage.bind(read));
  const snapshot = AsyncLocalStorage.snapshot();
  made[`${scope} snapshot`] = () => snapshot(read);
  const inRun = als.run("stored", () => AsyncLocalStorage.snapshot());
  made[`${scope} snapshot in run`] = () => inRun(read);
  const resource = new AsyncResource("probe");
  made[`${scope} resource`] = () => resource.runInAsyncScope(read);
  const runResource = als.run("stored", () => new AsyncResource("probe"));
  made[`${scope} resource in run`] = () => runResource.runInAsyncScope(read);
  made[`${scope} resource bind in run`] = runResource.bind(read);
};
make("module");

const call = () => Object.fromEntries(Object.entries(made).map(([name, fn]) => {
  try {
    return [name, fn()];
  } catch (error) {
    return [name, `${error.name}: ${error.message}`];
  }
}));

export default {
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path.endsWith("/make")) {
      make("request");
      // The same request, after an await.
      await new Promise((resolve) => setTimeout(resolve, 1));
      return Response.json(call());
    }
    return Response.json({
      later: call(),
      reported: Cloudflare.compatibilityFlags.bind_asynclocalstorage_snapshot_to_request ?? null,
    });
  },
};
