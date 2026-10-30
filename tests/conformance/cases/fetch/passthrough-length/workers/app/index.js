// A fetched gzip response a Worker returns as it is keeps its length:
// workerd passes the body on unread with the upstream's Content-Length,
// where celld sends a streamed body chunked.
export default {
  async fetch(request) {
    const url = new URL(request.url);
    const upstream = `http://127.0.0.1:${url.searchParams.get("port")}`;
    switch (url.pathname) {
      case "/gzip":
        return fetch(`${upstream}/encoded?as=gzip&text=passed`);
      case "/gzip-manual":
        return fetch(`${upstream}/encoded?as=gzip&text=manual`, { encodeResponseBody: "manual" });
    }
    return new Response("?");
  },
};
