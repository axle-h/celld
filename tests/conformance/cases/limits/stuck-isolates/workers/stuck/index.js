// A Worker whose turns hold their thread past its 10 ms limit, in a call
// that does not stop for a termination: `__celldTestHold`, which exists only
// on a node started with CELLD_CONFORMANCE_HOLD=1. Its own turns, its
// Durable Objects' and those of the Dynamic Worker it loads all count
// against it.
import { DurableObject } from "cloudflare:workers";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function outcome(call) {
  try {
    return { value: await call() };
  } catch (error) {
    return { error: error.name, message: error.message };
  }
}

export class Room extends DurableObject {
  ping() {
    return "pong";
  }
  // Placed before the holds. Once they are stuck it sends a new event to
  // an object already placed, which fails at once, and reaches an object
  // that has no home yet, which the node refuses to place.
  // Answers at once; the rest runs on, so no new event of this owner is
  // still to start when the holds begin.
  arm(placed, fresh, ms) {
    this.ctx.waitUntil(this.later(placed, fresh, ms));
    return "armed";
  }
  async later(placed, fresh, ms) {
    await pause(ms);
    const started = Date.now();
    const event = await outcome(() => this.env.ROOM.getByName(placed).ping());
    const eventMs = Date.now() - started;
    const result = {
      placed: { ...event, atOnce: eventMs < 500 },
      fresh: await outcome(() => this.env.ROOM.getByName(fresh).ping()),
    };
    // Kept: the request that asked runs in the stateless isolate the holds
    // condemn, so it cannot carry this back.
    await this.ctx.storage.put("later", result);
    return result;
  }
  async laterResult() {
    return (await this.ctx.storage.get("later")) ?? null;
  }
}

const dynamicSource = `export default {
  fetch(request) {
    const ms = Number(new URL(request.url).searchParams.get("ms") ?? "0");
    if (ms > 0) __celldTestHold(ms);
    return new Response("dynamic held");
  },
};`;

export default {
  fetch(request, env) {
    const url = new URL(request.url);
    const ms = Number(url.searchParams.get("ms") ?? "0");
    switch (url.pathname) {
      case "/dynamic": {
        const worker = env.LOADER.get("held", () => ({
          compatibilityDate: "2026-01-01",
          mainModule: "main.js",
          modules: { "main.js": dynamicSource },
          limits: { cpuMs: 10 },
        }));
        return worker.getEntrypoint().fetch(`http://dynamic/?ms=${ms}`);
      }
      case "/room-later":
        return env.ROOM.getByName("first")
          .arm("placed", "fresh", Number(url.searchParams.get("after")))
          .then((result) => new Response(result));
      case "/room-result":
        return env.ROOM.getByName("first")
          .laterResult()
          .then((result) => Response.json(result));
      case "/room":
        return env.ROOM.getByName(url.searchParams.get("name"))
          .ping()
          .then((value) => new Response(value));
    }
    // The review's shape: a sync `fetch` returning an async IIFE.
    return (async () => {
      if (ms > 0) __celldTestHold(ms);
      return new Response("held");
    })();
  },
};
