// Method lookup on a plain-object entrypoint, through a service binding to
// another Worker and through ctx.exports to this one.
import { handler } from "./handler.js";

// `undefined` does not survive JSON, so say what the value is as well.
async function attempt(fn) {
  try {
    const value = await fn();
    return { type: typeof value, value: value ?? null };
  } catch (error) {
    return { error: `${error.name}: ${error.message}` };
  }
}

async function lookup(target) {
  return {
    greet: await attempt(() => target.greet("a")),
    greetTwo: await attempt(() => target.greet("a", "b")),
    greetNone: await attempt(() => target.greet()),
    short: await attempt(() => target.short("a")),
    four: await attempt(() => target.four("a")),
    tooLong: await attempt(() => target.tooLong("a")),
    value: await attempt(() => target.value),
    valueCall: await attempt(() => target.value()),
    undef: await attempt(() => target.undef),
    missing: await attempt(() => target.missing()),
    missingGet: await attempt(() => target.missing),
    // A path through an own object: its functions get env and ctx too, with
    // the object as `this`.
    whoami: await attempt(() => target.nested.whoami("b")),
    deep: await attempt(() => target.nested.deep.v),
    nestedMissing: await attempt(() => target.nested.missing),
    nestedAlarm: await attempt(() => target.nested.alarm()),
    listLength: await attempt(() => target.list.length),
    alarm: await attempt(() => target.alarm("a")),
    webSocketMessage: await attempt(() => target.webSocketMessage("a")),
    webSocketClose: await attempt(() => target.webSocketClose("a")),
    webSocketError: await attempt(() => target.webSocketError("a")),
    dup: await attempt(() => target.dup("a")),
    // Inherited from Object.prototype, so not the handler's own.
    hasOwnProperty: await attempt(() => target.nested.hasOwnProperty("a")),
  };
}

export default {
  ...handler,
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    if (path === "/service") return Response.json(await lookup(env.BACK));
    if (path === "/exports") return Response.json(await lookup(ctx.exports.default));
    return new Response("not found", { status: 404 });
  },
};
