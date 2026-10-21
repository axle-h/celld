// `export default { fetch(request, env, ctx) }` reading `ctx.props`, called
// from `front` and from itself: through its own service bindings, through
// `ctx.exports.default`, and on `scheduled()`.
const describe = (props) => ({ type: typeof props, props: props ?? null });

function mutate(props) {
  try {
    props.mutated = true;
    return { ok: true, ...describe(props) };
  } catch (error) {
    return { ok: false, error: error.name };
  }
}

const echo = async (stub, path = "/echo") => (await stub.fetch(`http://plain.test${path}`)).json();

let lastScheduled = null;

async function scheduled(stub) {
  lastScheduled = null;
  const result = await stub.scheduled({ cron: "* * * * *" });
  return { outcome: result.outcome, props: lastScheduled };
}

export default {
  async fetch(request, env, ctx) {
    switch (new URL(request.url).pathname) {
      case "/mutate":
        return Response.json(mutate(ctx.props));
      case "/self":
        return Response.json({
          caller: describe(ctx.props),
          binding: await echo(env.SELF),
          bindingNone: await echo(env.SELF_NONE),
          bindingMutate: await echo(env.SELF, "/mutate"),
          bindingAfter: await echo(env.SELF),
          loopback: await echo(ctx.exports.default({ props: { who: "plain-loopback" } })),
          loopbackNone: await echo(ctx.exports.default),
          scheduled: await scheduled(env.SELF),
          scheduledNone: await scheduled(env.SELF_NONE),
        });
      default:
        return Response.json(describe(ctx.props));
    }
  },
  scheduled(controller, env, ctx) {
    lastScheduled = describe(ctx.props);
  },
};
