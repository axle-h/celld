// A global fetch() and Content-Encoding gzip, which workerd handles
// whatever the date: the response's body is decoded, its headers kept,
// unless the request has `encodeResponseBody: "manual"`; a body that is not
// gzip fails when it is read; no Accept-Encoding is sent. A fetched gzip
// response sent on as it is goes out as it came; one made from its decoded
// text is compressed again. Its length is fetch/passthrough-length.
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
  async fetch(request) {
    const url = new URL(request.url);
    const upstream = `http://127.0.0.1:${url.searchParams.get("port")}`;
    const encoded = (as, text) => `${upstream}/encoded?as=${as}&text=${encodeURIComponent(text)}`;
    switch (url.pathname) {
      case "/fetch": {
        const out = {};
        for (const as of ["gzip", "GZIP", "bad"]) {
          out[as] = await read(await fetch(encoded(as, `hello ${as}`)));
          out[`${as} manual`] = await read(await fetch(encoded(as, `hello ${as}`), { encodeResponseBody: "manual" }));
        }
        const head = await fetch(encoded("gzip", "head"), { method: "HEAD" });
        out.head = [head.headers.get("content-encoding"), head.body];
        // A copy keeps the mode, and a Request as the init gives its own.
        const manual = new Request(encoded("gzip", "copy"), { encodeResponseBody: "manual" });
        out.copy = (await read(await fetch(new Request(manual)))).body;
        out.reqInit = (await read(await fetch(encoded("gzip", "init"), manual))).body;
        out.clone = (await read(await fetch(manual.clone()))).body;
        return Response.json(out);
      }
      case "/pass":
        return fetch(encoded("gzip", "passed"));
      case "/pass-read": {
        const response = await fetch(encoded("gzip", "read and sent"));
        return new Response(await response.text(), response);
      }
      case "/pass-manual":
        return fetch(encoded("gzip", "manual passed"), { encodeResponseBody: "manual" });
    }
    return new Response("?");
  },
};
