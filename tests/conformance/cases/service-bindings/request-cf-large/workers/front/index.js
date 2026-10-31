// A `cf` of 100 KiB reaches another script's Worker. workerd sets no bound;
// celld carries at most 64 KiB of `cf` JSON out of an isolate (plan 1.69).
export default {
  async fetch(request, env) {
    const cf = { big: "x".repeat(100 * 1024) };
    try {
      return Response.json(await (await env.BACK.fetch("http://back.test/", { cf })).json());
    } catch (error) {
      return Response.json({ error: `${error.name}: ${error.message}` });
    }
  },
};
