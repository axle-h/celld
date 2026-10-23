// Refusals only. Every call here must be refused before it reaches its
// target, whose members all answer "REACHED": a Durable Object's lifecycle
// handlers and instance state, an entrypoint's reserved names (at every
// step of a path), and a transient target's `dup`. A call that is not
// refused shows up as "REACHED" in the transcript.
import { DurableObject, RpcStub, RpcTarget } from "cloudflare:workers";

const reached = () => "REACHED";

// The error a refused call rejects with, or what it answered instead.
async function refused(fn) {
  try {
    return { answered: await fn() };
  } catch (error) {
    return `${error.name}: ${error.message}`;
  }
}

export class Host extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.own = reached;
  }

  alarm() {
    return reached();
  }

  webSocketMessage() {
    return reached();
  }

  webSocketClose() {
    return reached();
  }

  webSocketError() {
    return reached();
  }

  dup() {
    return reached();
  }

  connect() {
    return reached();
  }

  get tools() {
    return {
      alarm: reached,
      webSocketMessage: reached,
      fetch: reached,
      connect: reached,
      dup: reached,
    };
  }
}

class Target extends RpcTarget {
  constructor() {
    super();
    this.own = reached;
  }

  dup() {
    return reached();
  }

  get child() {
    return new Target();
  }

  get nothing() {
    return undefined;
  }

  getObj() {
    return { dup: reached };
  }
}

// What a class entrypoint and a plain-object entrypoint refuse.
async function entrypoint(target) {
  return {
    alarm: await refused(() => target.alarm(1)),
    webSocketMessage: await refused(() => target.webSocketMessage(1)),
    webSocketClose: await refused(() => target.webSocketClose(1)),
    webSocketError: await refused(() => target.webSocketError(1)),
    dup: await refused(() => target.dup(1)),
    toolsAlarm: await refused(() => target.tools.alarm(1)),
    toolsFetch: await refused(() => target.tools.fetch(1)),
    toolsConnect: await refused(() => target.tools.connect(1)),
    toolsDup: await refused(() => target.tools.dup(1)),
  };
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === "/durable-object") {
      const host = env.HOST.getByName("refusals");
      return Response.json({
        alarm: await refused(() => host.alarm()),
        webSocketMessage: await refused(() => host.webSocketMessage()),
        webSocketClose: await refused(() => host.webSocketClose()),
        webSocketError: await refused(() => host.webSocketError()),
        dup: await refused(() => host.dup()),
        // Instance state, and celld's own field on every instance.
        own: await refused(() => host.own()),
        ctx: await refused(() => host.ctx),
        ctxStorage: await refused(() => host.ctx.storage.get("x")),
        env: await refused(() => host.env),
        state: await refused(() => host.__celldState),
        stateReset: await refused(() => host.__celldState._untilReset(1)),
        toolsAlarm: await refused(() => host.tools.alarm()),
        toolsWebSocketMessage: await refused(() => host.tools.webSocketMessage()),
        toolsFetch: await refused(() => host.tools.fetch()),
        toolsConnect: await refused(() => host.tools.connect()),
        toolsDup: await refused(() => host.tools.dup()),
      });
    }
    if (path === "/entrypoint") {
      return Response.json({
        ...(await entrypoint(env.ENTRY)),
        own: await refused(() => env.ENTRY.own()),
        ctx: await refused(() => env.ENTRY.ctx),
        env: await refused(() => env.ENTRY.env),
      });
    }
    if (path === "/object") return Response.json(await entrypoint(env.OBJECT));
    if (path === "/transient") {
      using target = new RpcStub(new Target());
      return Response.json({
        own: await refused(() => target.own()),
        childDup: await refused(() => target.child.dup()),
        nothing: await refused(() => target.nothing()),
        resultDup: await refused(() => target.getObj().dup()),
      });
    }
    return new Response("not found", { status: 404 });
  },
};
