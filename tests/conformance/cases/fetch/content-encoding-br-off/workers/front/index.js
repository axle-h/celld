// Content-Encoding br without brotli_content_encoding: workerd treats it as
// an encoding it does not know, and the body passes as it is, whether the
// request has `encodeResponseBody: "manual"` or not (api/system-streams.c++
// getContentEncoding), as celld always does (fetch/content-encoding-br).
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/target")
      return new Response("brotli body", { headers: { "content-encoding": "br" } });
    const read = async (response) => {
      const bytes = new Uint8Array(await response.arrayBuffer());
      return [response.headers.get("content-encoding"), bytes.byteLength,
        new TextDecoder().decode(bytes) === "brotli body" ? "plain" : "encoded"];
    };
    return Response.json({
      automatic: await read(await env.SELF.fetch("http://front/target")),
      manual: await read(await env.SELF.fetch("http://front/target", { encodeResponseBody: "manual" })),
    });
  },
};
