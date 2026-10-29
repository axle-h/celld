// What else waits on a Durable Object that another event resets (plan 1.30):
// in workerd none of it waits past the reset.
// - `/gate/*`: a blockConcurrencyWhile() callback still runs (a timer) when
//   another event calls ctx.abort(). A call sent through a fresh stub after
//   the abort reaches a new instance at once (`after`); one queued behind
//   the gate before it fails with the abort's error (`queued`).
// - `/facet/*`: the object awaits a call into its facet, which waits on a
//   timer; the reset fails the object's call at once.
// - `/alarm/*`: an alarm() handler waits on a timer; the object answers its
//   next call.
// A webSocketMessage() handler is `rpc/reset-websocket`.
// Every wait is bounded, so a hang reports "hung" instead of timing the step
// out.
import { DurableObject } from "cloudflare:workers";

const message = (error) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function attempt(fn) {
  try {
    return await fn();
  } catch (error) {
    return "threw " + message(error);
  }
}

function bounded(promise, ms = 2000) {
  return Promise.race([promise, sleep(ms).then(() => "hung")]);
}

export class Child extends DurableObject {
  async wait() {
    await sleep(5000);
    return "child returned";
  }
  ping() {
    return "pong";
  }
}

export class Obj extends DurableObject {
  gateHeld = Promise.withResolvers();
  aborterRunning = Promise.withResolvers();
  waiting = Promise.withResolvers();

  async holdGate() {
    await this.ctx.blockConcurrencyWhile(async () => {
      this.gateHeld.resolve();
      await sleep(3000);
    });
    return "block returned";
  }

  async abortInGate(delay) {
    this.aborterRunning.resolve();
    await this.gateHeld.promise;
    await sleep(delay);
    this.ctx.abort(new Error("aborted"));
  }

  async aborterStarted() {
    await this.aborterRunning.promise;
  }

  ping() {
    return "pong";
  }

  #facet() {
    return this.ctx.facets.get("child", () => ({ class: this.ctx.exports.Child }));
  }

  callFacet() {
    this.waiting.resolve();
    return this.#facet().wait();
  }

  pingFacet() {
    return this.#facet().ping();
  }

  async started() {
    await this.waiting.promise;
    return "started";
  }

  async reset(kind) {
    if (kind === "abort") {
      this.ctx.abort(new Error("aborted"));
      return "abort returned";
    }
    await this.ctx.blockConcurrencyWhile(async () => {
      throw new Error("block threw");
    });
  }

  async alarm() {
    this.waiting.resolve();
    await sleep(5000);
  }

  async arm() {
    await this.ctx.storage.setAlarm(Date.now());
  }
}

async function gate(ns, name, when) {
  const target = ns.getByName(name);
  // The aborting event runs before the block starts: one that arrived after
  // would queue behind it.
  const aborting = attempt(() => target.abortInGate(when === "queued" ? 300 : 0));
  await target.aborterStarted();
  const holding = attempt(() => target.holdGate());
  await sleep(100);
  const call = bounded(attempt(() => ns.getByName(name).ping()));
  return {
    aborting: await bounded(aborting),
    holding: await bounded(holding),
    [when]: await call,
    fresh: await bounded(attempt(() => ns.getByName(name).ping())),
  };
}

async function waitAndReset(ns, name, kind, wait) {
  const waiter = wait();
  const started = await bounded(attempt(() => ns.getByName(name).started()));
  const reset = await bounded(attempt(() => ns.getByName(name).reset(kind)));
  return { started, reset, waiter: await bounded(waiter, 3000) };
}

export default {
  async fetch(request, env) {
    const [, test, kind] = new URL(request.url).pathname.split("/");
    const ns = env.OBJ;
    const name = `${test}-${kind}`;
    if (test === "gate") return Response.json(await gate(ns, name, kind));
    if (test === "facet") {
      const out = await waitAndReset(ns, name, kind,
        () => attempt(() => ns.getByName(name).callFacet()));
      out.after = await bounded(attempt(() => ns.getByName(name).pingFacet()));
      return Response.json(out);
    }
    if (test === "alarm") {
      await ns.getByName(name).arm();
      const out = await waitAndReset(ns, name, kind, async () => "armed");
      out.after = await bounded(attempt(() => ns.getByName(name).ping()));
      return Response.json(out);
    }
    return new Response("not found", { status: 404 });
  },
};
