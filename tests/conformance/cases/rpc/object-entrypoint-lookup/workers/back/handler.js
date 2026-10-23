// A plain-object entrypoint (a copy of front/handler.js). workerd exposes its own properties only, at
// every step of a path, and reserves an entrypoint's handler names. A
// function it exposes is called as fn(arg, env, ctx): it must declare at
// most three parameters, and the client must send exactly one argument.
const tooLong = (arg) => arg;
Object.defineProperty(tooLong, "length", { value: 300 });

export const handler = {
  fetch() {
    return new Response("handler");
  },
  greet(arg, env, ctx) {
    return { arg, env: typeof env, ctx: typeof ctx.waitUntil };
  },
  short() {
    return "short";
  },
  four(a, b, c, d) {
    return "four";
  },
  tooLong,
  value: 7,
  undef: undefined,
  nested: {
    label: "nested",
    whoami(arg) {
      return `${this.label}:${arg}`;
    },
    alarm: () => "nested alarm reached",
    deep: { v: 1 },
  },
  list: [1, 2],
  // Reserved names, and own Object.prototype names, never reached.
  alarm: () => "alarm reached",
  webSocketMessage: () => "webSocketMessage reached",
  webSocketClose: () => "webSocketClose reached",
  webSocketError: () => "webSocketError reached",
  dup: () => "dup reached",
  connect: () => "connect reached",
  constructor: () => "constructor reached",
  toString: () => "toString reached",
};
