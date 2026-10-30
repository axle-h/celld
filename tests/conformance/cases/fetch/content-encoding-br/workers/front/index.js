// Content-Encoding br under brotli_content_encoding, on from 2024-04-29: a
// response sent with it is compressed, and a fetch() decodes it unless the
// request has `encodeResponseBody: "manual"` (api/system-streams.c++
// getContentEncoding). celld supports neither, as if the flag were off
// (fetch/content-encoding-br-off): the body passes as it is.
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
