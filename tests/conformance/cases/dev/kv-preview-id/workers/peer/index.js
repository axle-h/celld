export default {
  async fetch(request, env) {
    const out = {};
    for (const binding of ["BOTH_ID", "BOTH_PREVIEW", "PREVIEW_ONLY", "ID_ONLY", "NEITHER"])
      out[binding] = await env[binding].get("written");
    return Response.json(out);
  },
};
