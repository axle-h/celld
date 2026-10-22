// get(), put() and delete() on a service binding and a Durable Object stub:
// HTTP helpers under fetcher_has_get_put_delete (before 2024-03-26), and RPC
// methods under fetcher_no_get_put_delete.
import { DurableObject } from "cloudflare:workers";

async function attempt(fn) {
  try {
    const value = await fn();
    return { value: value === undefined ? "<undefined>" : value };
  } catch (error) {
    return { error: `${error.name}: ${error.message}` };
  }
}

// Each Worker exports its own subclass: celld refuses one class name in two
// co-hosted scripts.
export class Store extends DurableObject {
  fetch(request) {
    return new Response(`store ${request.method} ${new URL(request.url).pathname}`);
  }
  get(arg) {
    return `rpc get ${arg}`;
  }
}

export async function calls(env, { rpc }) {
  const out = {
    get: await attempt(() => env.BACK.get("http://back/item")),
    put: await attempt(() => env.BACK.put("http://back/item", "body")),
    delete: await attempt(() => env.BACK.delete("http://back/item")),
    reported: Cloudflare.compatibilityFlags.fetcher_no_get_put_delete,
  };
  if (rpc) {
    const stub = env.STORE.get(env.STORE.idFromName("x"));
    out.storeGet = await attempt(() => stub.get("http://store/item"));
  }
  return out;
}
