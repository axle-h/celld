import { checkAll, payload } from "#byob";

export default {
  async fetch(request, env) {
    await env.BUCKET.put("payload", payload());
    const whole = await checkAll(async () => (await env.BUCKET.get("payload")).body);
    // A ranged read: the body is the range.
    const range = await checkAll(
      async () => (await env.BUCKET.get("payload", { range: { offset: 1000, length: 50_000 } })).body,
      payload().slice(1000, 51_000),
    );
    return Response.json({ whole, range });
  },
};
