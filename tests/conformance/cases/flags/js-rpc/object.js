// RPC to a Durable Object class that does not extend DurableObject, which
// only js_rpc allows.
export class Counter {
  constructor(state) {
    this.state = state;
  }
  fetch() {
    return new Response("counter");
  }
  hello(name) {
    return `hello ${name}`;
  }
}

export async function call(env, path) {
  const stub = env.COUNTER.get(env.COUNTER.idFromName(path));
  let rpc;
  try {
    rpc = { value: await stub.hello("rpc") };
  } catch (error) {
    rpc = { error: `${error.name}: ${error.message}` };
  }
  return {
    rpc,
    fetch: await (await stub.fetch("http://counter/")).text(),
    reported: Cloudflare.compatibilityFlags.js_rpc,
  };
}
