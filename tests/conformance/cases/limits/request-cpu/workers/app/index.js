// CPU limits per invocation: a deployed Worker's `limits.cpu_ms` (hog: 50,
// this Worker and its Durable Object: 100) and a Dynamic Worker's `cpuMs`.
// A request past its limit fails with "Worker exceeded CPU time limit.",
// whether it spins in one turn or spends its time across many, and the node
// keeps serving. A Durable Object's event that runs out resets the object, as
// workerd aborts the object's IoContext: the turn's write never commits, an
// event still running on it fails, its stub stays broken, and a new stub
// reaches a new instance. Each event of an object has a limit of its own.
import { DurableObject } from "cloudflare:workers";
import { spin, work } from "../hog/index.js";

// A promise one object's event waits on and another's resolves: the waiter's
// continuation then runs in the resolver's turn, at its checkpoint.
const gates = new Map();
function gate(name) {
  if (!gates.has(name)) {
    let open;
    const opened = new Promise((resolve) => (open = resolve));
    gates.set(name, { opened, open });
  }
  return gates.get(name);
}

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.spun = false;
    this.waiting = false;
  }
  async burn() {
    work();
    return "burned";
  }
  async wait() {
    this.waiting = true;
    await new Promise((resolve) => setTimeout(resolve, 300));
    await this.ctx.storage.put("late", "written");
    return "waited";
  }
  async spin(mode) {
    // Start only once wait() runs, so the reset finds it in flight.
    while (!this.waiting) await new Promise((resolve) => setTimeout(resolve, 5));
    await this.ctx.storage.put("before", "kept");
    // A turn ends after the first write and commits it.
    await new Promise((resolve) => setTimeout(resolve, 0));
    this.spun = true;
    if (mode === "steps") {
      // Each turn stays far under the limit; together they pass it.
      for (let step = 0; step < 2000; step++) {
        work();
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      return "finished";
    }
    // This write is in the turn the limit ends, so it never commits.
    this.ctx.storage.put("doomed", "written");
    return spin();
  }
  // A statement that never returns to JavaScript: SQLite stops it at the
  // limit.
  async sqlSpin() {
    await this.ctx.storage.put("before", "kept");
    await new Promise((resolve) => setTimeout(resolve, 0));
    this.ctx.storage.put("doomed", "written");
    return this.ctx.storage.sql
      .exec("WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) AS n FROM c")
      .one().n;
  }
  // Waits for another object to open the gate, then spins in that object's
  // turn: this event ran out of CPU time, and fails, as does the turn's own.
  async waitThenSpin(name) {
    await gate(name).opened;
    return spin();
  }
  async open(name) {
    gate(name).open();
    return "opened";
  }
  async arm() {
    await this.ctx.storage.setAlarm(Date.now() + 10);
    return "armed";
  }
  // The first run spins past the limit and resets the object; the retry
  // runs in a new instance and records that it did.
  async alarm(info) {
    if (info.retryCount === 0) {
      this.ctx.storage.put("doomed", "written");
      return spin();
    }
    await this.ctx.storage.put("alarm", { retryCount: info.retryCount, instanceSpun: this.spun });
  }
  async alarmRun() {
    return (await this.ctx.storage.get("alarm")) ?? null;
  }
  async check() {
    return {
      instanceSpun: this.spun,
      before: (await this.ctx.storage.get("before")) ?? null,
      doomed: (await this.ctx.storage.get("doomed")) ?? null,
      late: (await this.ctx.storage.get("late")) ?? null,
    };
  }
}

const dynamicSource = `
function work() {
  let x = 1;
  for (let i = 0; i < 5e6; i++) x = (Math.imul(x, 1103515245) + 12345) | 0;
  return x;
}
function spin() {
  for (let i = 0; i < 5000; i++) work();
  return "spun";
}
let served = 0;
export default {
  async fetch(request) {
    const mode = new URL(request.url).searchParams.get("mode");
    served++;
    if (mode === "spin") return new Response(spin());
    return Response.json({ ok: true, alive: served > 1 });
  },
};`;

function dynamic(env, limits) {
  return env.LOADER.get(`dynamic-${JSON.stringify(limits)}`, () => ({
    compatibilityDate: "2026-01-01",
    mainModule: "main.js",
    modules: { "main.js": dynamicSource },
    ...(limits === undefined ? {} : { limits }),
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
      case "/spin":
        return new Response(spin());
      case "/other":
        return Response.json(await outcome(() => env.OTHER.fetch("http://other/")));
      case "/stateless":
        return Response.json(await outcome(() => env.HOG.fetch(`http://hog/?mode=${mode}`)));
      case "/stateless-json": {
        // Stopped near the limit, not when the loop ends (about 40 s).
        const started = Date.now();
        const result = await outcome(() => env.HOG.fetch("http://hog/?mode=json"));
        await new Promise((resolve) => setTimeout(resolve, 0));
        return Response.json({ result, withinSeconds: Date.now() - started < 5000 });
      }
      case "/stateless-concurrent": {
        // Only the request past its limit fails.
        const waiting = outcome(() => env.HOG.fetch("http://hog/?mode=wait"));
        const spinning = outcome(() => env.HOG.fetch("http://hog/?mode=spin"));
        return Response.json({ spin: await spinning, wait: await waiting });
      }
      case "/dynamic": {
        // The loader's limit, and the lower of it and the call's.
        const limits = url.searchParams.has("cpuMs")
          ? { cpuMs: Number(url.searchParams.get("cpuMs")) }
          : undefined;
        const call = url.searchParams.has("callMs")
          ? { limits: { cpuMs: Number(url.searchParams.get("callMs")) } }
          : undefined;
        const entrypoint = dynamic(env, limits).getEntrypoint(undefined, call);
        return Response.json(await outcome(() => entrypoint.fetch(`http://child/?mode=${mode}`)));
      }
      case "/alarm": {
        const armed = env.ROOM.getByName("alarm");
        await armed.arm();
        // The stub that armed it binds to the instance the alarm resets.
        let stale;
        for (let attempt = 0; attempt < 100; attempt++) {
          stale = await outcome(() => armed.alarmRun());
          if (stale.error !== undefined) break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        // A new stub reaches the new instance. Bounded: the retry backs off
        // for a few seconds.
        for (let attempt = 0; attempt < 300; attempt++) {
          const room = env.ROOM.getByName("alarm");
          const run = await room.alarmRun();
          if (run !== null) return Response.json({ stale, run, check: await room.check() });
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return Response.json({ run: "the alarm never ran again" });
      }
      case "/do-sql": {
        const room = env.ROOM.getByName("sql");
        await room.check();
        const spun = await outcome(() => room.sqlSpin());
        return Response.json({
          spun,
          stale: await outcome(() => room.check()),
          fresh: await outcome(() => env.ROOM.getByName("sql").check()),
        });
      }
      case "/do-cross": {
        const waiter = env.ROOM.getByName("waiter");
        const opener = env.ROOM.getByName("opener");
        await waiter.check();
        await opener.check();
        const waiting = outcome(() => waiter.waitThenSpin("cross"));
        await new Promise((resolve) => setTimeout(resolve, 100));
        const opening = outcome(() => opener.open("cross"));
        return Response.json({ waiter: await waiting, opener: await opening });
      }
      case "/do-events": {
        // Each event gets the limit afresh: sixty events of about 4 ms each
        // spend more than one event may.
        const room = env.ROOM.getByName("events");
        const results = [];
        for (let i = 0; i < 60; i++) results.push((await outcome(() => room.burn())).value);
        return Response.json({ burned: results.filter((value) => value === "burned").length });
      }
      case "/do": {
        const name = url.searchParams.get("name");
        const room = env.ROOM.getByName(name);
        if (mode === "check") return Response.json(await outcome(() => room.check()));
        // The stub binds to the instance the limit resets, and stays broken.
        await room.check();
        const waiting = outcome(() => room.wait());
        const spinning = outcome(() => room.spin(mode));
        return Response.json({
          spin: await spinning,
          wait: await waiting,
          stale: await outcome(() => room.check()),
        });
      }
    }
    return new Response("not found", { status: 404 });
  },
};
