const attempt = (fn) => {
  try {
    fn();
    return "set";
  } catch (error) {
    return `${error.name}: ${error.message}`;
  }
};

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname === "/incoming") {
      const clone = request.clone();
      return Response.json({
        original: attempt(() => request.headers.set("x-from", "worker")),
        clone: attempt(() => clone.headers.set("x-from", "worker")),
      });
    }
    const out = {};
    out.responseContentType = new Response("a string").headers.get("content-type");
    out.requestContentType = new Request("https://example.com/", { method: "POST", body: "a string" }).headers.get(
      "content-type",
    );
    out.statusText = {
      200: new Response(null).statusText,
      404: new Response(null, { status: 404 }).statusText,
      json: Response.json({}).statusText,
      redirect: Response.redirect("https://example.com/", 307).statusText,
      serviceBinding: (await env.BACK.fetch("http://back/")).statusText,
      network: (await fetch(`http://127.0.0.1:${new URL(request.url).searchParams.get("port")}/`)).statusText,
    };
    const response = new Response("abcdef");
    const reader = response.body.getReader({ mode: "byob" });
    const { value } = await reader.read(new Uint8Array(2));
    reader.releaseLock();
    out.partialRead = [new TextDecoder().decode(value), await response.text().catch((error) => `${error.name}: ${error.message}`)];
    return Response.json(out);
  },
};
