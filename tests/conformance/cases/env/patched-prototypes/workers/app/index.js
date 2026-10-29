// Refusals only (plan 1.49): a script replaces the intrinsics a harness
// could pass an object through, adds setters on Object.prototype for the
// names it could assign one to, replaces the methods of every prototype
// its own bindings expose -- the Durable Object namespace's
// `get`, `getByName` and `idFromName`, the stub prototype's members, and
// the storage, `storage.kv` and state methods -- and then uses its KV,
// Queue, D1 and Workflow bindings. Each replacement records a call whose
// receiver is not one of the script's own objects. The bindings reach their
// cells without any of these methods, and the workflow cell, which runs
// beside the script's code, through the harness's own storage methods, so
// none is recorded; the script's own calls still are.
import { DurableObject, WorkflowEntrypoint } from "cloudflare:workers";

const foreign = [];
const own = { namespace: 0, storage: 0 };
const mine = new WeakSet();

// Whether `value` is a capability of celld's own that a script must never
// hold: a workflow or cron cell's instance, or a ctx or storage object that
// is not one of this script's Durable Object's.
const reported = new WeakSet();
const hasOwn = Object.hasOwn;
let inspecting = false;
function capability(value) {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return false;
  // This script's own objects, and the prototypes it patches itself.
  if (mine.has(value) || reported.has(value) || hasOwn(value, "constructor")) return false;
  inspecting = true;
  try {
    if (typeof value.blockConcurrencyWhile === "function") return value.id?.name !== "x";
    return typeof value.__wfCreate === "function" ||
      typeof value.transactionSync === "function" ||
      (value.kv !== null && typeof value.kv === "object" && typeof value.kv.put === "function");
  } catch {
    return false;
  } finally {
    inspecting = false;
  }
}
function inspect(label, values) {
  for (const value of values) {
    if (capability(value)) {
      reported.add(value);
      foreign.push(label);
    }
  }
}

// The intrinsics a harness could hand an instance or storage object to, and
// setters on Object.prototype for the names it could assign one to. Every
// isolate of this script installs them as it loads, before any cell starts.
for (const [object, name] of [
  [Object, "defineProperty"], [Object, "defineProperties"], [Object, "hasOwn"],
  [Object, "create"], [Object, "assign"], [Object, "keys"], [Object, "setPrototypeOf"],
  [Object, "getPrototypeOf"], [Reflect, "apply"], [Reflect, "get"], [Reflect, "has"],
  [Reflect, "defineProperty"],
]) {
  const original = object[name];
  object[name] = function (...args) {
    inspect(`${name}`, [this, ...args]);
    return original.apply(this, args);
  };
}
for (const key of ["__celldState", "_state", "_storage", "state", "storage", "kv", "facets", "ctx"]) {
  Object.defineProperty(Object.prototype, key, {
    configurable: true,
    get() {
      return undefined;
    },
    set(value) {
      inspect(`set ${key}`, [this, value]);
      Reflect.defineProperty(this, key, { value, writable: true, enumerable: true, configurable: true });
    },
  });
}

// Replace `names` on `proto`, recording each call on a receiver `isOwn`
// does not claim.
function patch(proto, names, label, isOwn, counter) {
  for (const name of names) {
    const original = proto[name];
    proto[name] = function (...args) {
      if (isOwn(this)) own[counter]++;
      else foreign.push(`${label}.${name}`);
      return original.apply(this, args);
    };
  }
}

// The members a runtime cell's stub would be called through.
const CELL_METHODS = [
  "__kvGet", "__kvPut", "__kvDelete", "__kvList", "__queueSend", "__queueMetrics",
  "__d1Query", "__d1Batch", "__d1Exec", "__wfCreate", "__wfStatus",
];

// Cells of one script share its cell isolates, so the workflow cell runs
// where `Obj` installed the storage replacements; the output says so.
let installed = false;

export class Flow extends WorkflowEntrypoint {
  async run(event, step) {
    return await step.do("work", async () => ({ patched: installed }));
  }
}

export class Obj extends DurableObject {
  install() {
    const storage = this.ctx.storage;
    mine.add(storage);
    mine.add(storage.kv);
    mine.add(this.ctx);
    const isOwn = (value) => mine.has(value);
    patch(Object.getPrototypeOf(Object.getPrototypeOf(storage)),
      ["get", "put", "getAlarm", "setAlarm", "deleteAlarm", "transactionSync"],
      "storage", isOwn, "storage");
    patch(Object.getPrototypeOf(storage), ["transaction"], "storage", isOwn, "storage");
    patch(Object.getPrototypeOf(storage.kv), ["get", "put", "delete", "list"],
      "kv", isOwn, "storage");
    patch(Object.getPrototypeOf(this.ctx), ["blockConcurrencyWhile"], "ctx", isOwn, "storage");
    installed = true;
    return "installed";
  }

  async use() {
    await this.ctx.storage.put("k", "v");
    this.ctx.storage.kv.put("k", "v");
    await this.ctx.blockConcurrencyWhile(async () => {});
    return { value: await this.ctx.storage.get("k"), foreign, ownStorageCalls: own.storage > 0 };
  }
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === "/install") {
      const namespace = Object.getPrototypeOf(env.OBJ);
      patch(namespace, ["get", "getByName", "idFromName", "idFromString"], "namespace",
        (value) => value === env.OBJ, "namespace");
      const stubProto = Object.getPrototypeOf(env.OBJ.getByName("x"));
      for (const name of CELL_METHODS) {
        Object.defineProperty(stubProto, name, {
          configurable: true,
          get() {
            if (!inspecting) foreign.push(`stub.${name}`);
            return undefined;
          },
        });
      }
      return Response.json(await env.OBJ.getByName("x").install());
    }
    if (path !== "/use") return new Response("not found", { status: 404 });
    await env.KV.put("k", "v");
    const kv = [await env.KV.get("k"), (await env.KV.list()).keys.length];
    await env.KV.delete("k");
    await env.QUEUE.send("m");
    const queue = (await env.QUEUE.metrics()).backlogCount;
    const d1 = [
      await env.DB.prepare("SELECT 1 AS one").first("one"),
      (await env.DB.batch([env.DB.prepare("SELECT 2 AS two")]))[0].results[0].two,
      (await env.DB.exec("SELECT 3")).count,
    ];
    const instance = await env.FLOW.create({ id: "patched" });
    let workflow = null;
    for (let attempt = 0; attempt < 200; attempt++) {
      workflow = await instance.status();
      if (workflow.status === "complete" || workflow.status === "errored") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const object = await env.OBJ.getByName("x").use();
    return Response.json({
      kv,
      queue,
      d1,
      workflow: [workflow.status, workflow.output],
      object: object.value,
      foreign: [...foreign, ...object.foreign],
      ownNamespaceCalls: own.namespace > 0,
      ownStorageCalls: object.ownStorageCalls,
    });
  },
};
