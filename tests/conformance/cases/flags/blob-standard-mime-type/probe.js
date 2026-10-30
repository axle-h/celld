// Blob.type of a body's blob(), for each Content-Type the body carries.
// With blob_standard_mime_type it is the MIME type extracted from the header
// and serialized (workerd's MimeType::extract), else the header as it is.
const TYPES = [
  "",
  "text/plain",
  "Text/HTML; Charset=UTF-8",
  "text/plain;charset=\"utf-8\"",
  "text/plain; charset=utf-8, text/plain",
  "text/plain; charset=utf-8, text/html",
  "text/html, application/json",
  "text/html, */*",
  "text/html, nonsense",
  "*/*",
  "invalid",
  "text/",
  "/plain",
  "te xt/plain",
  "text/pl ain",
  " text/plain ",
  "text/plain ; a=b ; A=c",
  "text/plain;a=\"b\\\"c\\\\d\"",
  "text/plain;a=\"b;c\";d=e",
  "text/plain;a=\"b\" junk;d=e",
  "text/plain;a=\"open",
  "text/plain; x=; y=z",
  "text/plain; x=\"\"",
  "text/plain;x=a b",
  "text/plain;x=a@b",
  "text/plain;=x;y",
  "text/plain;bad name=x;ok=y",
  "multipart/form-data; boundary=abc; Charset=x",
  "application/json ; charset=utf-8",
  "text/plain\t",
  "text/plain;a=\u00ff",
  "text/plain;a=\u20ac",
];

async function blobType(make, type) {
  const headers = new Headers();
  if (type !== null) headers.set("content-type", type);
  return (await make(headers).blob()).type;
}

export default {
  async fetch() {
    const response = [];
    const request = [];
    for (const type of TYPES) {
      response.push(await blobType((headers) => new Response("x", { headers }), type));
      request.push(await blobType(
        (headers) => new Request("http://x/", { method: "POST", body: "x", headers }), type));
    }
    const twice = new Headers([["content-type", "Text/Plain; charset=a"], ["content-type", "text/plain"]]);
    return Response.json({
      response,
      request,
      appended: (await new Response("x", { headers: twice }).blob()).type,
      blobBody: (await new Response(new Blob(["x"], { type: "Text/Plain;A=B" })).blob()).type,
      reported: Cloudflare.compatibilityFlags.blob_standard_mime_type ?? null,
    });
  },
};
