export default {
  fetch(request) {
    const kind = new URL(request.url).pathname.slice(1);
    if (kind === "proxy") return new Proxy(new Response("proxied"), {});
    if (kind === "string") return "a string";
    return undefined;
  },
};
