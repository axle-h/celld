// The same report as front's `report`.
// In a header, so a HEAD request's answer carries it too.
const report = async (request) =>
  new Response(null, {
    headers: {
      "x-report": JSON.stringify({
        contentLength: request.headers.get("content-length"),
        transferEncoding: request.headers.get("transfer-encoding"),
        nullBody: request.body === null,
        text: await request.text(),
      }),
    },
  });

export default { fetch: report };
