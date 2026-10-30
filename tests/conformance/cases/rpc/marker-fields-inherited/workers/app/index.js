// A Request and a Response revived from structuredClone() and Durable
// Object storage while Object.prototype carries properties named
// like the fields of celld's markers: the copies take nothing from them.
import { DurableObject } from "cloudflare:workers";

const shape = (value) => value instanceof Request
  ? { class: "Request", url: value.url, method: value.method, cache: value.cache ?? null, cf: value.cf ?? null }
  : { class: "Response", status: value.status, statusText: value.statusText, cf: value.cf ?? null };

const inherited = { k: "no-store", c: { injected: true }, x: "manual", m: "PUT", t: "Injected", r: "manual" };

const withInherited = async (fn) => {
  for (const [key, value] of Object.entries(inherited))
    Object.defineProperty(Object.prototype, key, { value, configurable: true, writable: true });
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(inherited)) delete Object.prototype[key];
  }
};

export class Store extends DurableObject {
  async stored(kind) {
    const value = kind === "request" ? new Request("http://example.com/stored") : new Response(null, { status: 201 });
    await this.ctx.storage.put("value", value);
    return withInherited(async () => shape(await this.ctx.storage.get("value")));
  }
}

export default {
  async fetch(request, env) {
    const stub = env.STORE.getByName("store");
    const out = {};
    out.cloneRequest = await withInherited(() => shape(structuredClone(new Request("http://example.com/a"))));
    out.cloneResponse = await withInherited(() => shape(structuredClone(new Response(null, { status: 202 }))));
    out.storedRequest = await stub.stored("request");
    out.storedResponse = await stub.stored("response");
    return Response.json(out);
  },
};
