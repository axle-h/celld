import { checkAll, payload } from "#byob";

export default {
  async fetch(request, env) {
    await env.KV.put("payload", payload());
    return Response.json({
      get: await checkAll(() => env.KV.get("payload", "stream")),
      withMetadata: await checkAll(
        async () => (await env.KV.getWithMetadata("payload", { type: "stream" })).value),
    });
  },
};
