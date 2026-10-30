// Calls made back-to-back on a Durable Object stub reach the object in the
// order they were made, whether the object is starting or already running.
// Each event logs its tag as it begins, then waits on a timer, so the calls
// also overlap: an order kept by running them one at a time would show as
// `overlap` below `CALLS`.
//
// Fetches and RPC calls are each ordered among themselves. Between the two,
// workerd begins a fetch before an RPC call made just ahead of it, an
// artifact of how many turns each takes to arrive, which no case pins.
import { DurableObject } from "cloudflare:workers";

const CALLS = 24;

export class Recorder extends DurableObject {
  log = [];
  inFlight = 0;
  overlap = 0;

  async enter(tag) {
    this.log.push(tag);
    this.inFlight += 1;
    this.overlap = Math.max(this.overlap, this.inFlight);
    await scheduler.wait(100);
    this.inFlight -= 1;
    return tag;
  }

  async fetch(request) {
    return new Response(await this.enter(new URL(request.url).searchParams.get("tag")));
  }

  // The calls one object makes on another's stub, which may share its isolate.
  async callAnother(name) {
    return run([this.env.RECORDER.getByName(name)], viaRpc, "o");
  }

  report() {
    const report = { log: this.log, overlap: this.overlap };
    this.log = [];
    this.overlap = 0;
    return report;
  }
}

const tags = (prefix) => Array.from({ length: CALLS }, (_, index) => `${prefix}${index}`);

const viaRpc = (stub, tag) => stub.enter(tag);
const viaFetch = async (stub, tag) =>
  (await stub.fetch(`https://recorder/?tag=${encodeURIComponent(tag)}`)).text();

// Make every call at once, the nth on the nth stub in turn, and answer the
// order the object began them in.
async function run(stubs, send, prefix) {
  const sent = tags(prefix);
  const returned = await Promise.all(sent.map((tag, index) => send(stubs[index % stubs.length], tag)));
  const report = await stubs[0].report();
  return { ...report, returned };
}

const SCENARIOS = {
  // The first call starts the object, and every call waits for it.
  "/rpc-cold": (env) => run([env.RECORDER.getByName("rpc-cold")], viaRpc, "r"),
  "/rpc-warm": async (env) => {
    const stub = env.RECORDER.getByName("rpc-warm");
    await stub.report();
    return run([stub], viaRpc, "w");
  },
  "/fetch-cold": (env) => run([env.RECORDER.getByName("fetch-cold")], viaFetch, "f"),
  "/from-object": (env) => env.RECORDER.getByName("caller").callAnother("callee"),
  // Two stubs of one object, called in turn.
  "/two-stubs": (env) =>
    run([env.RECORDER.getByName("two-stubs"), env.RECORDER.getByName("two-stubs")], viaRpc, "s"),
};

export default {
  async fetch(request, env) {
    const scenario = SCENARIOS[new URL(request.url).pathname];
    if (!scenario) return new Response("not found", { status: 404 });
    return Response.json(await scenario(env));
  },
};
