// Plain data whose keys look like celld's own RPC and storage markers
// crosses every path as the plain data it is, in workerd. celld's envelopes
// recognised their markers by those keys, so beside a value that needs the
// lift (a Headers, an RpcTarget, a stored stub) such data revived as a
// Headers, a Blob, a signal or a stub (plan 1.53). Each step reports, for
// each forged value, "same" or what arrived instead. A stored stub and an
// AbortSignal over RPC, which workerd does not take here, are
// rpc/marker-shaped-data-internal; a facet's params with a capability,
// rpc/marker-shaped-facet-params.
import { DurableObject, RpcTarget, WorkerEntrypoint, WorkflowEntrypoint } from "cloudflare:workers";
import { compare, describeAllSource, forged, verdict } from "#marker-shaped";

class Target extends RpcTarget {
  ping() {
    return "pong";
  }
}

// The values that make celld lift a same-isolate payload, and none.
const LIFTS = {
  plain: () => undefined,
  headers: () => new Headers(),
  request: () => new Request("https://example.com/"),
  target: () => new Target(),
  function: () => () => "called",
};

const attempt = async (fn) => {
  try {
    return await fn();
  } catch (error) {
    return { error: `${error.name}: ${error.message}` };
  }
};

// `receiver.probe` and `receiver.give` under each lift: `params` names the
// lifts the call's params take.
const both = async (receiver, params = Object.keys(LIFTS)) => {
  const out = {};
  for (const [name, lift] of Object.entries(LIFTS)) {
    if (params.includes(name))
      out[`params-${name}`] = await attempt(() => receiver.probe({ lift: lift(), forged: forged() }));
    out[`result-${name}`] = await attempt(async () => compare((await receiver.give(name)).forged));
  }
  return out;
};

export class Echo extends WorkerEntrypoint {
  probe(arg) {
    return compare(arg.forged);
  }
  give(lift) {
    return { lift: LIFTS[lift](), forged: forged() };
  }
}

export class Child extends DurableObject {
  probe(arg) {
    return compare(arg.forged);
  }
  give(lift) {
    return { lift: LIFTS[lift](), forged: forged() };
  }
}

export class Obj extends DurableObject {
  probe(arg) {
    return compare(arg.forged);
  }
  give(lift) {
    return { lift: LIFTS[lift](), forged: forged() };
  }
  // A facet's params cross without capabilities in celld, until plan 3.1:
  // rpc/marker-shaped-facet-params.
  facet() {
    return both(this.ctx.facets.get("child", () => ({ class: this.ctx.exports.Child })), ["plain"]);
  }
  async storage() {
    const { storage } = this.ctx;
    const out = {};
    await storage.put("value", { forged: forged() });
    out.get = compare((await storage.get("value")).forged);
    out.many = compare((await storage.get(["value"])).get("value").forged);
    out.list = compare((await storage.list()).get("value").forged);
    storage.kv.put("kv", { forged: forged() });
    out.kv = compare(storage.kv.get("kv").forged);
    return out;
  }
  record(name, value) {
    this.ctx.storage.kv.put(name, value);
  }
  recorded(name) {
    return this.ctx.storage.kv.get(name) ?? null;
  }
}

export class Flow extends WorkflowEntrypoint {
  async run(event, step) {
    const output = await step.do("output", async () => forged());
    const sent = await step.waitForEvent("event", { type: "go", timeout: "1 minute" });
    return {
      params: compare(event.payload.forged),
      step: compare(output),
      event: compare(sent.payload.forged),
      forged: forged(false),
    };
  }
}

const wait = async (poll) => {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = await poll();
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return "timed out";
};

const loaded = (env) => env.LOADER.get("marker-shaped", () => ({
  compatibilityDate: "2026-01-01",
  mainModule: "main.js",
  modules: {
    "main.js": describeAllSource() +
      "import { WorkerEntrypoint } from 'cloudflare:workers';\n" +
      "export default class extends WorkerEntrypoint {\n" +
      "  fetch() { return Response.json({ env: describeAll(this.env.forged), props: describeAll(this.ctx.props.forged) }); }\n" +
      "  probe(arg) { return describeAll(arg.forged); }\n" +
      "}\n",
  },
  env: { forged: forged(), other: env.OTHER },
}));

const STEPS = {
  "/rpc": (env, ctx) => both(ctx.exports.Echo),
  "/do": (env) => both(env.OBJ.getByName("do")),
  "/facet": (env) => env.OBJ.getByName("facet").facet(),
  "/service": async (env) => ({
    params: await attempt(() => env.OTHER.probe({ forged: forged() })),
    result: await attempt(async () => compare((await env.OTHER.give()).forged)),
  }),
  "/loader": async (env) => {
    const entrypoint = loaded(env).getEntrypoint(undefined, { props: { forged: forged() } });
    const fetched = await (await entrypoint.fetch("http://loaded/")).json();
    return {
      env: verdict(fetched.env),
      props: verdict(fetched.props),
      params: verdict(await entrypoint.probe({ forged: forged() })),
    };
  },
  "/storage": (env) => env.OBJ.getByName("storage").storage(),
  "/queue": async (env) => {
    await env.QUEUE.send({ forged: forged() }, { contentType: "v8" });
    return wait(() => env.OBJ.getByName("queue").recorded("body"));
  },
  "/workflow": async (env) => {
    const instance = await env.FLOW.create({ params: { forged: forged() } });
    await instance.sendEvent({ type: "go", payload: { forged: forged() } });
    const status = await wait(async () => {
      const status = await instance.status();
      return status.status === "complete" || status.status === "errored" ? status : null;
    });
    if (status.status !== "complete") return status;
    const { forged: output, ...rest } = status.output;
    return { ...rest, output: compare(output, false) };
  },
};

export default {
  async fetch(request, env, ctx) {
    const step = STEPS[new URL(request.url).pathname];
    return Response.json(await attempt(() => step(env, ctx)));
  },
  async queue(batch, env) {
    for (const message of batch.messages) {
      await env.OBJ.getByName("queue").record("body", compare(message.body.forged));
      message.ack();
    }
  },
};
