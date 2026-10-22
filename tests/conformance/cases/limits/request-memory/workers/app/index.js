// A stateless Worker (hog), a Dynamic Worker and a Durable Object each exceed
// the heap limit in a request. Each request fails with workerd's error, the
// node keeps serving another Worker, and the next request runs in a new
// isolate. The object resets: what it stored before stays, an event still
// running on it fails, and its write after the reset is refused.
import { DurableObject } from "cloudflare:workers";
import { hog } from "../hog/hog.js";

let poisoned = false;

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.poisoned = false;
    this.waiting = false;
  }
  async wait() {
    this.waiting = true;
    await new Promise((resolve) => setTimeout(resolve, 300));
    await this.ctx.storage.put("late", "written");
    return "waited";
  }
  async hog(mode) {
    // Start only once wait() runs, so the reset finds it in flight.
    while (!this.waiting) await new Promise((resolve) => setTimeout(resolve, 5));
    await this.ctx.storage.put("before", "kept");
    poisoned = true;
    this.poisoned = true;
    return hog(mode);
  }
  async check() {
    return {
      isolatePoisoned: poisoned,
      instancePoisoned: this.poisoned,
      before: (await this.ctx.storage.get("before")) ?? null,
      late: (await this.ctx.storage.get("late")) ?? null,
    };
  }
}

// A facet class of a Dynamic Worker. "hog" exceeds the limit inside a write
// transaction, so the database it leaves behind is locked until something
// closes it.
const facetSource = `
import { DurableObject } from "cloudflare:workers";
export class App extends DurableObject {
  async fetch(request) {
    const mode = new URL(request.url).searchParams.get("mode");
    if (mode === "hog") {
      await this.ctx.storage.transaction(async (txn) => {
        await txn.put("held", true);
        const keep = [];
        for (let i = 0; i < 8e6; i++) keep.push([i, 1, 2]);
      });
      return new Response("committed");
    }
    const count = (await this.ctx.storage.get("count")) ?? 0;
    await this.ctx.storage.put("count", count + 1);
    return new Response(String(count));
  }
}`;

// A root whose facet runs in a Dynamic Worker's isolate. Each cycle exceeds
// the limit in the facet inside a write transaction, then uses the facet's
// storage from the next isolate. The condemned isolate must let go of the
// facet, its database included, or the write after it waits on the lock and
// every condemned heap stays alive.
export class Supervisor extends DurableObject {
  facet() {
    const worker = this.env.LOADER.get("facet", () => ({
      compatibilityDate: "2026-01-01",
      mainModule: "app.js",
      modules: { "app.js": facetSource },
    }));
    return this.ctx.facets.get("app", () => ({ class: worker.getDurableObjectClass("App") }));
  }
  async call(mode) {
    return outcome(() => this.facet().fetch(`http://facet/?mode=${mode}`));
  }
  async cycles(count) {
    const results = [];
    for (let cycle = 0; cycle < count; cycle++) {
      const hog = await this.call("hog");
      // A Worker that keeps exceeding the limit loads again after a backoff,
      // which this waits out.
      let after;
      for (let attempt = 0; attempt < 120; attempt++) {
        after = await this.call("count");
        if (after.status === 200) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      results.push({ hog, after: after.status === 200 ? "usable" : after });
    }
    return results;
  }
}

const dynamicSource = `
let poisoned = false;
export default {
  async fetch(request) {
    const mode = new URL(request.url).searchParams.get("mode");
    if (mode === "check") return Response.json({ poisoned });
    poisoned = true;
    if (mode === "one") return new Response("allocated " + "\\u1234".repeat(2e8).toLowerCase().length);
    if (mode === "wait") {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const keep = [];
      for (let i = 0; i < 6e6; i++) keep.push([i, 1, 2]);
      globalThis.waited = keep;
      return new Response("waited " + keep.length);
    }
    const keep = [];
    for (let i = 0; i < 8e6; i++) keep.push([i, 1, 2]);
    return new Response("allocated " + keep.length);
  },
};`;

// One loaded Worker for each id. A Worker whose isolates keep exceeding the
// limit loads again only after a backoff, so each scenario has its own.
function dynamic(env, id) {
  return env.LOADER.get(id, () => ({
    compatibilityDate: "2026-01-01",
    mainModule: "main.js",
    modules: { "main.js": dynamicSource },
  }));
}

async function outcome(call) {
  try {
    const result = await call();
    if (!(result instanceof Response)) return { value: result };
    const type = result.headers.get("content-type") ?? "";
    return { status: result.status, body: type.includes("json") ? await result.json() : await result.text() };
  } catch (error) {
    return { error: error.name, message: error.message };
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const mode = url.searchParams.get("mode");
    switch (url.pathname) {
      case "/other":
        return Response.json(await outcome(() => env.OTHER.fetch("http://other/")));
      case "/stateless":
        return Response.json(await outcome(() => env.HOG.fetch(`http://hog/?mode=${mode}`)));
      case "/stateless-concurrent": {
        // A request in flight in the isolate when another one in it exceeds
        // the limit fails too, without running again.
        const waiting = outcome(() => env.HOG.fetch("http://hog/?mode=wait"));
        await new Promise((resolve) => setTimeout(resolve, 200));
        const hogging = outcome(() => env.HOG.fetch("http://hog/?mode=gradual"));
        return Response.json({ hog: await hogging, wait: await waiting });
      }
      case "/dynamic-concurrent": {
        const entrypoint = dynamic(env, "concurrent").getEntrypoint();
        const waiting = outcome(() => entrypoint.fetch("http://hog/?mode=wait"));
        await new Promise((resolve) => setTimeout(resolve, 200));
        const hogging = outcome(() => entrypoint.fetch("http://hog/?mode=gradual"));
        return Response.json({ hog: await hogging, wait: await waiting });
      }
      case "/dynamic": {
        const worker = dynamic(env, url.searchParams.get("id"));
        return Response.json(await outcome(() => worker.getEntrypoint().fetch(`http://hog/?mode=${mode}`)));
      }
      case "/facet":
        return Response.json(await env.SUPERVISOR.getByName("supervisor").cycles(3));
      case "/do": {
        const room = env.ROOM.getByName("room");
        if (mode === "check") return Response.json(await outcome(() => room.check()));
        const waiting = outcome(() => room.wait());
        const hogging = outcome(() => room.hog(mode));
        return Response.json({ hog: await hogging, wait: await waiting });
      }
    }
    return new Response("not found", { status: 404 });
  },
};
