// The request stays alive after its response (`waitUntil`), as the
// fetched source does: the request's end would cancel it, and the tee with it.
const linger = (ctx, ms) => ctx.waitUntil(new Promise((resolve) => setTimeout(resolve, ms)));

export default {
  async fetch(request, env, ctx) {
    const response = await env.BACK.fetch("http://back/");
    const clone = response.clone();
    // The tee is under way, and waits on the quiet source.
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (new URL(request.url).pathname === "/cancel-both") {
      await response.body.cancel();
      await clone.body.cancel();
      linger(ctx, 5000);
      return new Response("cancelled both");
    }
    linger(ctx, 85000);
    return new Response("left both unread");
  },
};
