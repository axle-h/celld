export default {
  async fetch(request, env) {
    await env.BUCKET.put("written", "app");
    await env.DB.exec("CREATE TABLE written (by TEXT)");
    return new Response(await (await env.PEER.fetch("http://peer/")).text(), {
      headers: { "content-type": "application/json" },
    });
  },
};
