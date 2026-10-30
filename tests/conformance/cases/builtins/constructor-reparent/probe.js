// Body, Request, Response and ReadableStream extend nothing in workerd: each
// constructor's prototype is Function.prototype, and giving one another
// prototype changes no construction, the runtime's own included (the
// request a handler receives, a fetch() and its response), with
// workers_api_getters_setters_on_prototype and without it (worker "old",
// at /old).
const classes = { Body, Request, Response, ReadableStream };
const prototypes = Object.fromEntries(Object.entries(classes).map(([name, cls]) =>
  [name, Object.getPrototypeOf(cls) === Function.prototype]));
// A new.target whose `prototype` is not an object gives Object.prototype,
// and a call without `new` workerd's TypeError.
const constructed = {};
for (const [name, cls] of Object.entries(classes)) {
  const args = name === "Request" ? ["http://x/"] : [];
  const target = function () {};
  target.prototype = 5;
  const attempt = (fn) => {
    try {
      return fn();
    } catch (error) {
      return `${error.name}: ${error.message}`;
    }
  };
  constructed[name] = [
    attempt(() => Object.getPrototypeOf(Reflect.construct(cls, args, target)) === Object.prototype),
    attempt(() => cls(...args)),
  ];
}
const calls = [];
const planted = { planted: true };
for (const [name, cls] of Object.entries(classes)) {
  Object.setPrototypeOf(cls, function () {
    calls.push(name);
    return planted;
  });
}

const shape = (value, cls) => [value instanceof cls, value === planted];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/target") return new Response("from target");
    if (url.pathname === "/old") return env.OLD.fetch("http://old/");
    const out = { prototypes, constructed };
    out.incoming = [shape(request, Request), request.method, url.pathname];
    const response = await env.SELF.fetch("http://self/target");
    out.fetched = [shape(response, Response), await response.text()];
    out.request = shape(new Request("http://x/", { method: "POST", body: "x" }), Request);
    out.response = shape(new Response("y"), Response);
    out.stream = shape(new ReadableStream(), ReadableStream);
    out.text = await new Response(new Response("piped").body).text();
    out.calls = calls;
    return Response.json(out);
  },
};
