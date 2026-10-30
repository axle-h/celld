// An incoming request's signal under enable_request_signal, which has no
// date: with it, the signal aborts when the caller goes away; without it,
// request.signal is a signal of the Request's own that never aborts, and a
// copy of the Request gets another.
const held = [];

async function hold(request) {
  const signal = request.signal;
  const entry = {
    aborted: signal.aborted,
    stable: request.signal === signal,
    copied: new Request(request).signal === signal,
  };
  held.push(entry);
  await new Promise((resolve) => {
    signal.addEventListener("abort", () => {
      entry.reason = `${signal.reason?.name}: ${signal.reason?.message}`;
      resolve();
    });
    // A cancelled request's timers may never fire (workerd drops them), so
    // nothing is recorded after this.
    setTimeout(resolve, 600);
  });
  return new Response("held");
}

// Calls `/hold` on `target`, abandons the call, and reads what the handler saw.
async function abandon(target) {
  const controller = new AbortController();
  const pending = target.fetch("http://x/hold", { signal: controller.signal })
    .then((response) => response.text(), (error) => `rejected: ${error.name}`);
  await scheduler.wait(100);
  controller.abort();
  const result = await pending;
  await scheduler.wait(900);
  const entries = await (await target.fetch("http://x/held")).json();
  return { result, entries };
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === "/hold") return hold(request);
    if (path === "/held") return Response.json(held.splice(0));
    return Response.json({
      self: await abandon(env.SELF),
      reported: Cloudflare.compatibilityFlags.enable_request_signal ?? null,
    });
  },
};
