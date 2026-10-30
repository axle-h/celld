// handle_cross_request_promise_resolution: a promise that one request made
// and another resolves runs its continuations in the request that made it,
// or, when that request is over, drops them with a warning. Without the flag
// they run at once in the request that resolved it. workerd does this with
// its own V8 patches (promise context tags), which celld's V8 lacks; celld
// behaves as without the flag (plan 1.64).
const log = [];
let resolveLater;

export default {
  async fetch(request) {
    if (new URL(request.url).pathname.endsWith("/make")) {
      const promise = new Promise((resolve) => { resolveLater = resolve; });
      promise.then((value) => log.push(`continuation ${value}`));
      return new Response("made");
    }
    log.push("resolving");
    resolveLater("x");
    log.push("resolved");
    await Promise.resolve();
    log.push("after a microtask");
    await new Promise((resolve) => setTimeout(resolve, 20));
    return Response.json({
      log: log.splice(0),
      reported: Cloudflare.compatibilityFlags.handle_cross_request_promise_resolution ?? null,
    });
  },
};
