// `this.ctx.props` delivered to a named entrypoint and to the default export,
// over fetch, over RPC and to `scheduled()`: across scripts through service
// bindings that declare `props`, and within this script through `ctx.exports`
// loopback stubs and through service bindings to this script. A call that
// changes its props leaves the next call's alone.
import { WorkerEntrypoint } from "cloudflare:workers";

const describe = (props) => ({ type: typeof props, props: props ?? null });

const PROPS = { who: "loopback", nested: { list: [1, { two: [2] }], nil: null } };

// Change the props in place, and say what they look like after.
function mutate(props) {
  try {
    props.mutated = true;
    if (props.nested) props.nested.mutated = true;
    return { ok: true, ...describe(props) };
  } catch (error) {
    return { ok: false, error: error.name };
  }
}

// Each transport's change, then what the next call on the same stub sees.
async function mutation(stub) {
  const rpc = await stub.mutate();
  const rpcAfter = await stub.props();
  const fetch = await (await stub.fetch("http://front.test/mutate")).json();
  const fetchAfter = await (await stub.fetch("http://front.test/echo")).json();
  return { rpc, rpcAfter, fetch, fetchAfter };
}

// A loopback stub's props are copied when it is made, and each call on it
// gets a fresh instance.
async function snapshot(ctx) {
  const source = structuredClone(PROPS);
  const stub = ctx.exports.Local({ props: source });
  source.who = "changed after the stub was made";
  return {
    snapshot: (await stub.props()).props.who,
    instances: [await stub.bump(), await stub.bump(), await ctx.exports.Local.bump()],
    uncloneable: await attempt(() => ctx.exports.Local({ props: { f: () => 1 } }).props()),
  };
}

let lastScheduled = null;

async function scheduled(stub) {
  lastScheduled = null;
  const result = await stub.scheduled({ cron: "* * * * *" });
  return { outcome: result.outcome, props: lastScheduled };
}

// Both transports to one stub. `/echo` reaches the echo below when the stub
// is this script's default export; `back` echoes on every path.
async function both(stub) {
  return {
    fetch: await (await stub.fetch("http://front.test/echo")).json(),
    rpc: await stub.props(),
  };
}

export class Local extends WorkerEntrypoint {
  fetch(request) {
    const props = new URL(request.url).pathname === "/mutate" ? mutate(this.ctx.props) : describe(this.ctx.props);
    return Response.json(props);
  }
  props() {
    return describe(this.ctx.props);
  }
  mutate() {
    return mutate(this.ctx.props);
  }
  count = 0;
  bump() {
    return ++this.count;
  }
}

const attempt = async (f) => {
  try {
    return await f();
  } catch (error) {
    return `${error.name}: ${error.message}`;
  }
};

export default class extends WorkerEntrypoint {
  props() {
    return describe(this.ctx.props);
  }

  mutate() {
    return mutate(this.ctx.props);
  }

  scheduled() {
    lastScheduled = describe(this.ctx.props);
  }

  async fetch(request) {
    const { env, ctx } = this;
    switch (new URL(request.url).pathname) {
      case "/echo":
        return Response.json(describe(ctx.props));
      case "/mutate":
        return Response.json(mutate(ctx.props));
      case "/mutation":
        return Response.json({
          named: await mutation(env.NAMED),
          default: await mutation(env.DEFAULT),
          namedNone: await mutation(env.NAMED_NONE),
          defaultNone: await mutation(env.DEFAULT_NONE),
          selfNamed: await mutation(env.SELF_NAMED),
          selfDefault: await mutation(env.SELF_DEFAULT),
          selfNone: await mutation(env.SELF_NONE),
          loopbackNamed: await mutation(ctx.exports.Local({ props: structuredClone(PROPS) })),
          loopbackDefault: await mutation(ctx.exports.default({ props: structuredClone(PROPS) })),
          loopbackNone: await mutation(ctx.exports.Local),
        });
      case "/object-default":
        return Response.json({
          cross: await (await env.PLAIN.fetch("http://plain.test/echo")).json(),
          crossNone: await (await env.PLAIN_NONE.fetch("http://plain.test/echo")).json(),
          crossMutate: await (await env.PLAIN.fetch("http://plain.test/mutate")).json(),
          crossAfter: await (await env.PLAIN.fetch("http://plain.test/echo")).json(),
          self: await (await env.PLAIN.fetch("http://plain.test/self")).json(),
        });
      case "/scheduled":
        return Response.json({
          default: await scheduled(env.SELF_DEFAULT),
          defaultNone: await scheduled(env.SELF_DEFAULT_NONE),
        });
      case "/cross":
        return Response.json({
          named: await both(env.NAMED),
          default: await both(env.DEFAULT),
          namedNone: await both(env.NAMED_NONE),
          defaultNone: await both(env.DEFAULT_NONE),
        });
      case "/local":
        return Response.json({
          named: await both(ctx.exports.Local({ props: PROPS })),
          default: await both(ctx.exports.default({ props: PROPS })),
          namedNone: await both(ctx.exports.Local),
          defaultNone: await both(ctx.exports.default),
          ...(await snapshot(ctx)),
        });
      case "/self-binding":
        return Response.json({
          named: await both(env.SELF_NAMED),
          default: await both(env.SELF_DEFAULT),
          namedNone: await both(env.SELF_NONE),
          defaultNone: await both(env.SELF_DEFAULT_NONE),
        });
      default:
        return new Response("not found", { status: 404 });
    }
  }
}
