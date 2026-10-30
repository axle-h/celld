// Content-Encoding gzip, which workerd handles whatever the date: a response
// with `Content-Encoding: gzip` is compressed when it is sent, unless it has
// `encodeBody: "manual"`, and a service binding's fetch() decodes it, unless
// the request has `encodeResponseBody: "manual"`. A request body is never
// encoded. A global fetch() is covered by fetch/content-encoding-direct, and
// `br`, the same under brotli_content_encoding, which celld does not
// support, by fetch/content-encoding-br.
const read = async (response) => {
  let body;
  try {
    const bytes = new Uint8Array(await response.arrayBuffer());
    body = [bytes.byteLength, new TextDecoder().decode(bytes.subarray(0, 2)) === "\x1f�" ? "gzip bytes" : new TextDecoder().decode(bytes)];
  } catch (error) {
    body = `${error.name}: ${error.message}`;
  }
  return {
    status: response.status,
    encoding: response.headers.get("content-encoding"),
    length: response.headers.get("content-length"),
    acceptEncoding: response.headers.get("x-accept-encoding"),
    body,
  };
};
const gunzip = async (response) => new Response(
  response.body.pipeThrough(new DecompressionStream("gzip"))).text();

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const upstream = `http://127.0.0.1:${url.searchParams.get("port")}`;
    const encoded = (as, text) => `${upstream}/encoded?as=${as}&text=${encodeURIComponent(text)}`;
    switch (url.pathname) {
      case "/request-body": {
        const echoed = await (await fetch(`${upstream}/echo`, {
          method: "POST", body: "plain", headers: { "content-encoding": "gzip" },
        })).json();
        const out = { requestBody: echoed.body };
        try {
          new Request("http://x/", { encodeResponseBody: "other" });
        } catch (error) {
          out.badMode = `${error.name}: ${error.message}`;
        }
        try {
          new Response("x", { encodeBody: "other" });
        } catch (error) {
          out.badBodyMode = `${error.name}: ${error.message}`;
        }
        return Response.json(out);
      }
      case "/out":
        return new Response("hello out", { headers: { "content-encoding": "gzip", "content-length": "9" } });
      case "/out-manual": {
        const body = new Response("raw").body.pipeThrough(new CompressionStream("gzip"));
        return new Response(body, { headers: { "content-encoding": "gzip" }, encodeBody: "manual" });
      }
      case "/out-copy": {
        // `new Response(body, response)` keeps the response's mode.
        const body = new Response("copied").body.pipeThrough(new CompressionStream("gzip"));
        const manual = new Response(body, { headers: { "content-encoding": "gzip" }, encodeBody: "manual" });
        return new Response(manual.body, manual);
      }
      case "/binding": {
        const out = {};
        out.auto = await read(await env.BACK.fetch("http://back/plain"));
        out.manual = await gunzip(await env.BACK.fetch("http://back/plain", { encodeResponseBody: "manual" }));
        out.targetManual = await read(await env.BACK.fetch("http://back/raw"));
        out.members = await read(await env.BACK.fetch("http://back/members"));
        out.truncated = await read(await env.BACK.fetch("http://back/truncated"));
        out.garbage = await read(await env.BACK.fetch("http://back/garbage"));
        out.longName = await read(await env.BACK.fetch("http://back/long-name"));
        out.headerCrc = await read(await env.BACK.fetch("http://back/header-crc"));
        out.badHeaderCrc = await read(await env.BACK.fetch("http://back/bad-header-crc"));
        out.self = await read(await env.SELF.fetch(`http://self/out?port=${url.searchParams.get("port")}`));
        out.selfManual = await gunzip(await env.SELF.fetch(`http://self/out?port=${url.searchParams.get("port")}`, { encodeResponseBody: "manual" }));
        return Response.json(out);
      }
    }
    return new Response("?");
  },
};
