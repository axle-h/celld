// Refusals only: each step names a cell of `back`'s namespaces from
// `front`'s code, and expects the host to refuse it (plan 1.49). A scope is
// computable from public strings, so naming one must not reach it: the host
// checks the call against what `front`'s own configuration binds. `/own`
// shows the same paths still reach `front`'s own cells.
import { DurableObject } from "cloudflare:workers";

// celld's namespace keys, which are fixed strings.
const BACK_VAULT = ["Vault", "cells:v1:4:back:Vault"];
const BACK_FLOW = ["__Workflow.back", "cells:v1:4:back:__Workflow.back"];
const KV = ["__KvNamespace", "cells:v1:kv:__KvNamespace"];
const QUEUE = ["__Queue", "cells:v1:queue:__Queue"];
const D1 = ["__D1Database", "cells:v1:d1:__D1Database"];

// The error a refused call rejects with, or what it answered instead.
async function refused(fn) {
  try {
    return { answered: await fn() };
  } catch (error) {
    return `${error.name}: ${error.message}`;
  }
}

// A namespace of any class, through the constructor every namespace shares.
function namespace(env, [className, key]) {
  return new env.PROBE.constructor(className, key);
}

export class Child extends DurableObject {
  fetch() {
    return new Response("child");
  }
}

export class Probe extends DurableObject {
  alarm() {}

  // The storage and alarm operations, with the storage object naming
  // another object's scope.
  async storage(target) {
    const storage = this.ctx.storage;
    const own = storage._scope;
    storage._scope = target;
    storage.sql._scope = target;
    try {
      const out = {};
      for (const [name, use] of Object.entries({
        get: () => storage.get("k"),
        put: () => storage.put("k", "v"),
        list: () => storage.list().then((map) => [...map]),
        kvGet: () => storage.kv.get("k"),
        sql: () => storage.sql.exec("SELECT 1 AS one").toArray(),
        getAlarm: () => storage.getAlarm(),
        setAlarm: () => storage.setAlarm(Date.now() + 60_000),
        deleteAlarm: () => storage.deleteAlarm(),
      })) {
        out[name] = await refused(use);
      }
      return out;
    } finally {
      storage._scope = own;
      storage.sql._scope = own;
    }
  }

  // A facet, with the facet manager naming another object as its own.
  async facet(target) {
    const facets = this.ctx.facets;
    const own = facets._state;
    facets._state = { _scope: target, _facetDepth: 0 };
    try {
      return await refused(() => facets.get("child", () => ({ class: this.ctx.exports.Child }))
        .fetch("http://child/").then((response) => response.text()));
    } finally {
      facets._state = own;
    }
  }

  // blockConcurrencyWhile with the gate's cell forged to another object:
  // the input gate is the running object's, never a scope from JS, so a
  // forged scope cannot shut another object's gate.
  async gate(target) {
    const ctx = this.ctx;
    const own = ctx._scope;
    const out = {};
    for (const [name, scope] of Object.entries({ crossScript: target, sameScript: own + "x" })) {
      ctx._scope = scope;
      try {
        out[name] = await refused(() => ctx.blockConcurrencyWhile(() => "ran"));
      } finally {
        ctx._scope = own;
      }
    }
    // The running object's own gate still works.
    out.own = await refused(() => ctx.blockConcurrencyWhile(() => "ran"));
    return out;
  }

  async setValue(v) {
    await this.ctx.storage.put("v", v);
    return "set";
  }
  async getValue() {
    return (await this.ctx.storage.get("v")) ?? null;
  }
  // ctx.abort() with the object scope forged to another object: a reset acts
  // only on the object this is the registered instance of, so a forged scope
  // resets at most this object, never the named one.
  async abortForged(target) {
    const ctx = this.ctx;
    const own = ctx._scope;
    ctx._scope = target;
    try {
      ctx.abort("forged abort");
      return "aborted";
    } finally {
      ctx._scope = own;
    }
  }

  // The same operations on this object's own storage and facet.
  async own() {
    await this.ctx.storage.put("k", "v");
    const facet = await this.ctx.facets.get("own", () => ({ class: this.ctx.exports.Child }))
      .fetch("http://child/");
    return {
      get: await this.ctx.storage.get("k"),
      sql: this.ctx.storage.sql.exec("SELECT 1 AS one").one().one,
      alarm: await this.ctx.storage.setAlarm(Date.now() + 60_000).then(() => "set"),
      facet: await facet.text(),
    };
  }
}

export default {
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/back/")) return env.BACK.fetch(request);
    if (path === "/own") {
      await env.KV.put("k", "front");
      await env.QUEUE.send("front");
      return Response.json({
        object: await env.PROBE.getByName("own").own(),
        exports: await ctx.exports.Probe.getByName("own").own().then((own) => own.get),
        kv: await env.KV.get("k"),
        queue: "sent",
        d1: await env.DB.prepare("SELECT 1 AS one").first("one"),
      });
    }
    if (path === "/do-fetch") {
      return Response.json(await refused(() => namespace(env, BACK_VAULT).getByName("x")
        .fetch("http://vault/").then((response) => response.text())));
    }
    if (path === "/do-rpc") {
      return Response.json(await refused(() => namespace(env, BACK_VAULT).getByName("x").read()));
    }
    if (path === "/runtime") {
      return Response.json({
        kv: await refused(() => namespace(env, KV).getByName("back-kv/0").__kvGet({ keys: ["k"] })),
        queue: await refused(() => namespace(env, QUEUE).getByName("back-jobs").__queueMetrics({})),
        dlq: await refused(() => namespace(env, QUEUE).getByName("back-dlq").__queueMetrics({})),
        d1: await refused(() => namespace(env, D1).getByName("back-db").__d1Exec({ sql: "SELECT 1" })),
        workflow: await refused(() => namespace(env, BACK_FLOW).getByName("back-flow/x")
          .fetch("http://flow/").then((response) => response.text())),
        // Another shard of front's own KV namespace is not front's cell.
        kvShard: await refused(() => namespace(env, KV).getByName("front-kv/1").__kvGet({ keys: ["k"] })),
      });
    }
    const target = `Vault:${namespace(env, BACK_VAULT).idFromName("x")}`;
    if (path === "/storage") return Response.json(await env.PROBE.getByName("probe").storage(target));
    if (path === "/facet") return Response.json(await env.PROBE.getByName("probe").facet(target));
    if (path === "/gate") return Response.json(await env.PROBE.getByName("probe").gate(target));
    if (path === "/abort") {
      const victim = env.PROBE.getByName("victim");
      const attacker = env.PROBE.getByName("attacker");
      await victim.setValue("victim-value");
      const victimScope = `Probe:${env.PROBE.idFromName("victim")}`;
      const attack = await refused(() => attacker.abortForged(victimScope));
      return Response.json({ attack, victim: await victim.getValue() });
    }
    return new Response("not found", { status: 404 });
  },
};
