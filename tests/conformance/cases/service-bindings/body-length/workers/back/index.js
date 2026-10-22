export default {
  fetch(request) {
    return Response.json({
      contentLength: request.headers.get("content-length"),
      transferEncoding: request.headers.get("transfer-encoding"),
    });
  },
};
