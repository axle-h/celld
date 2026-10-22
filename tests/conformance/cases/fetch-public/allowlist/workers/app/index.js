// CELLD_FETCH_PRIVATE_ALLOW names host:port pairs. The runner's upstream
// server listens on two loopback ports. The node allows `localhost` on the
// first and `127.0.0.1` on the second:
// - a name entry matches the URL's host as written, on its port only;
// - an IP entry matches that address on its port only, however the URL
//   reached it, so `localhost` on the second port connects to 127.0.0.1.
async function probe(url) {
  try {
    const response = await fetch(url);
    return { url, status: response.status, body: await response.text() };
  } catch (error) {
    return { url, error: error.name, message: error.message };
  }
}

export default {
  async fetch(request) {
    const params = new URL(request.url).searchParams;
    const port = params.get("port");
    const other = params.get("other");
    return Response.json([
      await probe(`http://localhost:${port}/`),
      await probe(`http://127.0.0.1:${port}/`),
      await probe(`http://127.0.0.1:${other}/`),
      await probe(`http://localhost:${other}/`),
      await probe(`http://[::1]:${other}/`),
    ]);
  },
};
