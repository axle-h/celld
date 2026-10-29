// Refusals only (plan 1.49): `front` must not reach `back`'s namespaces, and
// no state a script can write names a cell. A scope is computable from public
// strings, so the host checks every call against what `front`'s own
// configuration binds (unit-tested in `js::scope_grant_op_tests`, since no
// script can hand the host a scope any more). These steps check that the
// harness hands a script nothing that would: the namespace and id
// constructors are refused, the storage, facet and state objects keep their
// scope private, and a forged property names nothing. `/own` shows the same
// paths still reach `front`'s own cells.
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

// The scope-shaped state a script could once write.
const SCOPED = ["_scope", "_state", "_className", "_namespaceKey", "_stub", "_namespace"];
const scoped = (object) => SCOPED.filter((name) => name in object);

export class Child extends DurableObject {
  fetch() {
    return new Response("child");
  }
}

export class Probe extends DurableObject {
  alarm() {}

  // The storage objects keep their scope private: a `_scope` a script sets
  // is a property of its own, and the operations still act on this object.
  async storage(target) {
    const storage = this.ctx.storage;
    const before = { storage: scoped(storage), sql: scoped(storage.sql), kv: scoped(storage.kv) };
    storage._scope = target;
    storage.sql._scope = target;
    try {
      await storage.put("k", "forged");
      return {
        before,
        get: await storage.get("k"),
        sql: storage.sql.exec("SELECT 1 AS one").one().one,
        setAlarm: await storage.setAlarm(Date.now() + 60_000).then(() => "set"),
      };
    } finally {
      delete storage._scope;
      delete storage.sql._scope;
    }
  }

  // The facet manager keeps its object private: a `_state` naming another
  // object leaves the facet this object's.
  async facet(target) {
    const facets = this.ctx.facets;
    const before = scoped(facets);
    facets._state = { _scope: target, _facetDepth: 0 };
    try {
      return {
        before,
        facet: await refused(() => facets.get("child", () => ({ class: this.ctx.exports.Child }))
          .fetch("http://child/").then((response) => response.text())),
      };
    } finally {
      delete facets._state;
    }
  }

  // blockConcurrencyWhile acts on this object's gate whatever `_scope` says.
  async gate(target) {
    const ctx = this.ctx;
    const out = { before: scoped(ctx) };
    for (const [name, scope] of Object.entries({ crossScript: target, sameScript: "Probe:x" })) {
      ctx._scope = scope;
      try {
        out[name] = await refused(() => ctx.blockConcurrencyWhile(() => "ran"));
      } finally {
        delete ctx._scope;
      }
    }
    return out;
  }

  async setValue(v) {
    await this.ctx.storage.put("v", v);
    return "set";
  }
  async getValue() {
    return (await this.ctx.storage.get("v")) ?? null;
  }
  // ctx.abort() with `_scope` set to another object's: a reset acts only on
  // the object this ctx is, so the named object keeps its state.
  async abortForged(target) {
    const ctx = this.ctx;
    ctx._scope = target;
    try {
      ctx.abort("forged abort");
      return "aborted";
    } finally {
      delete ctx._scope;
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
    if (path === "/namespace") {
      // Every namespace shares one constructor, which a script once called
      // with any class and key; and an id's constructor, with any value.
      const construct = (key) => refused(() => new env.PROBE.constructor(...key));
      const id = env.PROBE.idFromName("x");
      return Response.json({
        vault: await construct(BACK_VAULT),
        workflow: await construct(BACK_FLOW),
        kv: await construct(KV),
        queue: await construct(QUEUE),
        d1: await construct(D1),
        id: await refused(() => new id.constructor("Vault", id.toString())),
        namespace: scoped(env.PROBE),
        idState: scoped(id),
        bindings: { kv: scoped(env.KV), queue: scoped(env.QUEUE), db: scoped(env.DB) },
      });
    }
    const target = `Vault:${"ab".repeat(32)}`;
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
