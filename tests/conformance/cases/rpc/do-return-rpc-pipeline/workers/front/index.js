// Pipelined calls on an RpcTarget a Durable Object returns, from the fetch
// handler's isolate: IlyaGulya's cloudflare-os-compat
// `/do-return-rpc-pipeline`, and Cloudflare OS's GatekeeperLoopback, a
// get-only Proxy over the un-awaited `startGatekeeperSession()`.
import { DurableObject, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";

async function attempt(fn) {
  try {
    const value = await fn();
    return { type: typeof value, value: value ?? null };
  } catch (error) {
    return { error: `${error.name}: ${error.message}` };
  }
}

class ReturnedTool extends RpcTarget {
  echo(value) {
    return `returned:${value}`;
  }
  get info() {
    return { label: "tool" };
  }
}

export class Host extends DurableObject {
  returnTool() {
    return new ReturnedTool();
  }
}

export class GatekeeperLoopback extends WorkerEntrypoint {
  constructor(ctx, env) {
    super(ctx, env);
    const session = env.HOST.getByName("gatekeeper").returnTool();
    return new Proxy(session, {
      get(target, prop) {
        return Reflect.get(target, prop, target);
      },
      getPrototypeOf() {
        return WorkerEntrypoint.prototype;
      },
    });
  }

  dummyMethod() {}
}

export default {
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    if (path === "/do-return-rpc-pipeline") {
      const host = env.HOST.getByName("rpc-return-pipeline");
      return Response.json({ result: await host.returnTool().echo("hello") });
    }
    if (path === "/more") {
      const host = env.HOST.getByName("more");
      return Response.json({
        property: await attempt(() => host.returnTool().info.label),
        awaited: await attempt(async () => (await host.returnTool()).echo("awaited")),
        gatekeeper: await attempt(() => ctx.exports.GatekeeperLoopback.echo("gatekeeper")),
      });
    }
    return new Response("not found", { status: 404 });
  },
};
