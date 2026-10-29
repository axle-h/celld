// Runs one HTMLRewriter transform whose element handler waits 2 s, so its
// parser stays parked on the token while front's handler runs.
let output = null;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/hold") {
      const waiting = new Promise((resolve) => setTimeout(resolve, 2000));
      const source = new Response("<p>back</p>", { headers: { "content-type": "text/html" } });
      const transformed = new HTMLRewriter()
        .on("p", { element: () => waiting })
        .transform(source);
      ctx.waitUntil(transformed.text().then((text) => (output = text)));
      return new Response("holding");
    }
    if (url.pathname === "/report") {
      for (let i = 0; output === null && i < 60; i++) await new Promise((resolve) => setTimeout(resolve, 50));
      return new Response(output ?? "<no output>");
    }
    return new Response("not found", { status: 404 });
  },
};
