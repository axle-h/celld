// Which stubs a Durable Object reset breaks (plan 1.30). In workerd a stub
// binds to the instance its first call reaches. Once that instance is reset
// (a failed blockConcurrencyWhile(), or ctx.abort()), the stub stays broken:
// every later call or fetch() throws the reset's error, whoever reset it. A
// stub that never called (`unused`), and a fresh one, reach a new instance.
// - `/stateless/*` and `/object/*`: from a stateless Worker and from another
//   Durable Object; `self-abort` resets through the stub that later calls.
// - `/queued`: a call queued behind the failed block binds its stub too.
// - `/typed`: the stale stub keeps the error's type and own properties.
// - `/constructor`: a broken stub reaches no instance, so no constructor
//   runs for it.
import { DurableObject } from "cloudflare:workers";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function attempt(fn) {
  try {
    return await fn();
  } catch (error) {
    return `${error.name}: ${error.message}`;
  }
}

async function probe(ns, name, kind) {
  const used = ns.getByName(name);
  const unused = ns.getByName(name);
  const resetter = ns.getByName(name);
  const out = { before: await attempt(() => used.count()) };
  if (kind === "self-abort") out.reset = await attempt(() => used.selfAbort());
  else out.reset = await attempt(() => (kind === "block" ? resetter.fail() : resetter.abort()));
  await sleep(200);
  out.used = await attempt(() => used.count());
  out.unused = await attempt(() => unused.count());
  out.resetter = await attempt(() => resetter.count());
  out.fresh = await attempt(() => ns.getByName(name).count());
  out.usedFetch = await attempt(() => used.fetch("http://x/").then((r) => r.text()));
  out.resetterProperty = await attempt(() => resetter.property);
  out.usedAgain = await attempt(() => used.count());
  return out;
}

export class Obj extends DurableObject {
  calls = 0;
  armed = Promise.withResolvers();
  waiting = Promise.withResolvers();

  get property() {
    return "property";
  }

  count() {
    this.calls += 1;
    return this.calls;
  }

  async whenArmed() {
    this.waiting.resolve();
    await this.armed.promise;
  }

  async waiterStarted() {
    await this.waiting.promise;
  }

  async fail() {
    await this.ctx.blockConcurrencyWhile(async () => {
      this.armed.resolve();
      await sleep(100);
      throw new Error("block failed");
    });
  }

  async failTyped() {
    await this.ctx.blockConcurrencyWhile(async () => {
      const error = new TypeError("typed failure");
      error.code = 42;
      throw error;
    });
  }

  abort() {
    this.ctx.abort("aborted here");
  }

  selfAbort() {
    this.ctx.abort();
  }

  fetch() {
    return new Response(`fetched ${this.count()}`);
  }

  probe(name, kind) {
    return probe(this.env.OBJ, name, kind);
  }
}

let constructed = 0;

export class Counted extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    constructed += 1;
  }

  constructed() {
    return constructed;
  }

  async fail() {
    await this.ctx.blockConcurrencyWhile(async () => {
      throw new Error("block failed");
    });
  }
}

export default {
  async fetch(request, env) {
    const [, from, kind] = new URL(request.url).pathname.split("/");
    if (from === "stateless") return Response.json(await probe(env.OBJ, `stateless-${kind}`, kind));
    if (from === "object")
      return Response.json(await env.OBJ.getByName(`caller-${kind}`).probe(`object-${kind}`, kind));
    if (from === "queued") {
      const target = env.OBJ.getByName("queued"), queued = env.OBJ.getByName("queued");
      // Running before the block starts, so this call is not queued behind
      // it.
      const armed = target.whenArmed();
      await target.waiterStarted();
      const failing = attempt(() => target.fail());
      await armed;
      return Response.json({
        queued: await attempt(() => queued.count()),
        failing: await failing,
        queuedAgain: await attempt(() => queued.count()),
        fresh: await attempt(() => env.OBJ.getByName("queued").count()),
      });
    }
    if (from === "typed") {
      const stub = env.OBJ.getByName("typed");
      const code = async (fn) => {
        try {
          await fn();
          return null;
        } catch (error) {
          return [error instanceof TypeError, error.code ?? null];
        }
      };
      return Response.json({
        before: await attempt(() => stub.count()),
        reset: await attempt(() => stub.failTyped()),
        after: await attempt(() => stub.count()),
        kept: await code(() => stub.count()),
      });
    }
    const stub = env.COUNTED.getByName("counted");
    const before = await attempt(() => stub.constructed());
    const reset = await attempt(() => stub.fail());
    const stale = [await attempt(() => stub.constructed()), await attempt(() => stub.constructed())];
    return Response.json({ before, reset, stale, fresh: await attempt(() => env.COUNTED.getByName("counted").constructed()) });
  },
};
