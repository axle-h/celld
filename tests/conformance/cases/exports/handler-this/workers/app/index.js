// workerd calls the default export's handler as its method, so `this` is the
// exported object, for a request and for a service binding's call alike.
const handler = {
  marker: "exported",
  describe() {
    return { isExport: this === handler, keys: this === undefined ? null : Object.keys(this) };
  },
  async fetch(request, env) {
    const self = this === undefined ? null : this.describe();
    if (new URL(request.url).pathname === "/inner") return Response.json(self);
    const inner = await env.SELF.fetch("http://app/inner");
    return Response.json({ outer: self, inner: await inner.json() });
  },
};
export default handler;
