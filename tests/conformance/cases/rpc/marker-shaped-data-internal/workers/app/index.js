// Plain data shaped like celld's markers, beside the values celld lifts that
// workerd does not take here (plan 1.53): a stub in a stored value, read back
// through every storage read, and an AbortSignal in a call's params and
// result, within the isolate and to another Worker's isolate. Each read
// reports, for each forged value, "same" or what arrived instead, and that
// the value beside it still works. `/objects` stores, beside a stub, the
// objects V8 writes as plain objects whatever prototype they claim, which
// workerd stores as plain objects (rpc/marker-shaped-objects): "plain" for
// each that reads back as one.
import { DurableObject, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { OBJECT_NAMES, compare, forged, object, plainVerdict } from "#marker-shaped";

const isSignal = (value) => value instanceof AbortSignal;

export class Echo extends WorkerEntrypoint {
  ping() {
    return "pong";
  }
  probe(arg) {
    return { forged: compare(arg.forged), signal: isSignal(arg.signal) };
  }
  give() {
    return { signal: new AbortController().signal, forged: forged() };
  }
}

export class Obj extends DurableObject {
  ping() {
    return "pong";
  }
  async storage() {
    const { storage } = this.ctx;
    const out = {};
    const stubs = { service: this.ctx.exports.Echo, object: this.env.OBJ.getByName("other") };
    for (const [name, stub] of Object.entries(stubs)) {
      await storage.put(name, { stub, forged: forged() });
      const read = {
        get: await storage.get(name),
        many: (await storage.get([name])).get(name),
        list: (await storage.list({ prefix: name })).get(name),
      };
      storage.kv.put(`kv-${name}`, { stub, forged: forged() });
      read.kv = storage.kv.get(`kv-${name}`);
      read.kvList = [...storage.kv.list({ prefix: `kv-${name}` })][0][1];
      for (const [how, value] of Object.entries(read)) {
        out[`${name}-${how}`] = { forged: compare(value.forged), stub: await value.stub.ping() };
      }
    }
    return out;
  }
  async objects() {
    const { storage } = this.ctx;
    const stub = this.ctx.exports.Echo;
    const out = {};
    for (const name of OBJECT_NAMES) {
      await storage.put(name, { stub, v: object(name, RpcTarget) });
      storage.kv.put(`kv-${name}`, { stub, v: object(name, RpcTarget) });
      out[name] = {
        get: plainVerdict((await storage.get(name)).v),
        kv: plainVerdict(storage.kv.get(`kv-${name}`).v),
      };
    }
    return out;
  }
}

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname === "/storage") return Response.json(await env.OBJ.getByName("a").storage());
    if (pathname === "/objects") return Response.json(await env.OBJ.getByName("b").objects());
    const signal = () => new AbortController().signal;
    const given = await ctx.exports.Echo.give();
    return Response.json({
      params: await ctx.exports.Echo.probe({ signal: signal(), forged: forged() }),
      result: { forged: compare(given.forged), signal: isSignal(given.signal) },
      service: await env.OTHER.probe({ signal: signal(), forged: forged() }),
    });
  },
};
