// The response to a HEAD request, and one with a null body status, has a
// null body when it arrives (http.c++ makeHttpResponse), whatever the
// target sent: celld gave each a body stream.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/target") {
      const status = Number(url.searchParams.get("status"));
      const gzip = url.searchParams.has("gzip");
      return new Response(status === 200 ? "target body" : null, {
        status,
        headers: gzip ? { "content-encoding": "gzip", "x-target": "yes" } : { "x-target": "yes" },
      });
    }
    const out = {};
    const shape = async (response) => [response.status, response.headers.get("x-target"), response.body === null, await response.text()];
    out.head = await shape(await env.SELF.fetch("http://front/target?status=200", { method: "HEAD" }));
    out.headGzip = await shape(await env.SELF.fetch("http://front/target?status=200&gzip", { method: "HEAD" }));
    for (const status of [204, 205, 304])
      out[status] = await shape(await env.SELF.fetch(`http://front/target?status=${status}`));
    out.get = await shape(await env.SELF.fetch("http://front/target?status=200"));
    return Response.json(out);
  },
};
