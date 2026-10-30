// The Cache API's checks that come before any lookup or store, inside a
// request: a method called on something that is not a Cache, and put() of
// an error response, which workerd refuses before it reads the key
// (api/cache.c++), so even an invalid key gets that error. Each rejects.
const outcome = (call) => {
  let promise;
  try {
    promise = call();
  } catch (error) {
    return Promise.resolve(`threw ${error.constructor.name}: ${error.message}`);
  }
  return promise.then(
    (value) => `resolved ${typeof value}`,
    (error) => `rejected ${error.constructor.name}: ${error.message}`);
};

export default {
  async fetch() {
    const cache = caches.default;
    const calls = {
      putError: () => cache.put("http://x/", Response.error()),
      putErrorBadKey: () => cache.put("ftp://x/", Response.error()),
      putErrorPost: () =>
        cache.put(new Request("http://x/", { method: "POST" }), Response.error()),
      putIllegalThis: () => Cache.prototype.put.call({}, "http://x/", new Response("x")),
      putIllegalThisPrimitive: () => Cache.prototype.put.call(1, "http://x/", new Response("x")),
      matchIllegalThis: () => Cache.prototype.match.call({}, "http://x/"),
      deleteIllegalThis: () => Cache.prototype.delete.call({}, "http://x/"),
    };
    const out = {};
    for (const [name, call] of Object.entries(calls)) out[name] = await outcome(call);
    return Response.json(out);
  },
};
