// A Durable Object "target" is reset by one event ("reset": ctx.abort(), or
// a blockConcurrencyWhile() callback that throws) while another of its
// events ("b") still waits: on nothing, on a timer, or on a call to another
// object that never answers. In workerd the reset fails "b" at once, and
// whoever awaits it catches the reset's error: a stateless Worker
// (`/stateless/...`) and another Durable Object ("caller", `/object/...`)
// alike. celld answered "b" only once the timer fired, or never, so a
// Durable Object caller hung, and later calls to it and to fresh objects
// timed out (plan 1.30). `/after` checks that both kinds of object still
// answer. Every wait is bounded, so a hang reports "hung" instead of timing
// the step out.
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

export class Target extends DurableObject {
  running = Promise.withResolvers();

  async started() {
    await this.running.promise;
    return "started";
  }

  async b(wait) {
    this.running.resolve();
    if (wait === "forever") await new Promise(() => {});
    else if (wait === "timer") await sleep(5000);
    else await this.env.TARGET.getByName(`${this.ctx.id.name}-silent`).silent();
    return "b returned";
  }

  silent() {
    return new Promise(() => {});
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

  ping() {
    return "pong";
  }
}

export class Caller extends DurableObject {
  call(name, wait) {
    return attempt(() => this.env.TARGET.getByName(name).b(wait));
  }

  ping() {
    return "pong";
  }
}

export default {
  async fetch(request, env) {
    const [, from, kind, wait] = new URL(request.url).pathname.split("/");
    if (from === "after") {
      return Response.json({
        caller: await bounded(attempt(() => env.CALLER.getByName("object-abort-timer").ping())),
        freshCaller: await bounded(attempt(() => env.CALLER.getByName("fresh").ping())),
        target: await bounded(attempt(() => env.TARGET.getByName("object-abort-timer").ping())),
        freshTarget: await bounded(attempt(() => env.TARGET.getByName("fresh").ping())),
      });
    }
    const name = `${from}-${kind}-${wait}`;
    const call = from === "stateless"
      ? attempt(() => env.TARGET.getByName(name).b(wait))
      : env.CALLER.getByName(name).call(name, wait);
    const target = env.TARGET.getByName(name);
    const started = await bounded(attempt(() => target.started()));
    const reset = await bounded(attempt(() => target.reset(kind)));
    return Response.json({ started, reset, call: await bounded(call) });
  },
};
