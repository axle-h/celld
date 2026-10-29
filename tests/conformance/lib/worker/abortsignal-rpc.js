// The AbortSignal checks that flags/abortsignal-rpc and
// rpc/abortsignal-without-flag run with and without the experimental
// enable_abortsignal_rpc flag. workerd checks the flag before anything else
// when it serializes a signal (basics.c++ AbortSignal::serialize), then that
// the serialization is for RPC. A signal sent over RPC stays live: an abort
// after the call started reaches the receiver.
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

async function attempt(fn) {
  try {
    return await fn();
  } catch (error) {
    return `${error.name}: ${error.message}`;
  }
}

// What a receiver sees of a signal: aborted on arrival, and after a wait in
// which its sender aborts it.
async function observe(signal) {
  const before = signal.aborted;
  await new Promise((resolve) => setTimeout(resolve, 50));
  return { isSignal: signal instanceof AbortSignal, before, after: signal.aborted, reason: String(signal.reason) };
}

export class Echo extends WorkerEntrypoint {
  probe(arg) {
    return observe(arg.signal);
  }
  give() {
    const controller = new AbortController();
    controller.abort("given");
    return controller.signal;
  }
}

export class Obj extends DurableObject {
  probe(arg) {
    return observe(arg.signal);
  }
  put() {
    return attempt(async () => {
      await this.ctx.storage.put("k", { signal: new AbortController().signal });
      return "stored";
    });
  }
}

// Send a fresh signal through `call` and abort it once the call is under way.
async function sendAndAbort(call) {
  const controller = new AbortController();
  const result = attempt(() => call(controller.signal));
  setTimeout(() => controller.abort("late"), 10);
  return result;
}

export default {
  async fetch(request, env, ctx) {
    const flags = globalThis.Cloudflare.compatibilityFlags;
    const loaded = (source, loadEnv) =>
      env.LOADER.load({
        compatibilityDate: "2026-01-01",
        mainModule: "main.js",
        modules: { "main.js": source },
        env: loadEnv,
      });
    return Response.json({
      flag: flags.enable_abortsignal_rpc ?? "absent",
      params: await sendAndAbort((signal) => ctx.exports.Echo.probe({ signal })),
      durableObject: await sendAndAbort((signal) => env.OBJ.getByName("a").probe({ signal })),
      result: await attempt(async () => {
        const signal = await ctx.exports.Echo.give();
        return { isSignal: signal instanceof AbortSignal, aborted: signal.aborted, reason: String(signal.reason) };
      }),
      loaderParams: await attempt(() =>
        loaded(
          "import { WorkerEntrypoint } from 'cloudflare:workers';\n" +
            "export default class extends WorkerEntrypoint {\n" +
            "  probe(arg) { return arg.signal instanceof AbortSignal; }\n" +
            "}\n",
        )
          .getEntrypoint()
          .probe({ signal: new AbortController().signal }),
      ),
      storage: await env.OBJ.getByName("a").put(),
      loaderEnv: await attempt(async () => {
        const worker = loaded("export default { fetch() { return new Response('loaded'); } };", {
          signal: new AbortController().signal,
        });
        return (await worker.getEntrypoint().fetch("http://loaded/")).text();
      }),
      structuredClone: await attempt(() => {
        structuredClone({ signal: new AbortController().signal });
        return "cloned";
      }),
    });
  },
};
