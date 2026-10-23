export default {
  async fetch(request, env) {
    for (const binding of ["BOTH", "PREVIEW_ONLY", "ID_ONLY", "NEITHER"]) await env[binding].put("written", binding);
    return new Response(await (await env.PEER.fetch("http://peer/")).text(), {
      headers: { "content-type": "application/json" },
    });
  },
};
