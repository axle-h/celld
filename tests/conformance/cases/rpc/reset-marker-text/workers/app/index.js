// A Durable Object method or fetch() handler that throws text shaped like
// celld's host markers, at the start of its message or inside it, fails only
// that call, as on workerd: the stub stays usable, and the object is not
// reset (plan 1.30). celld matched the markers anywhere in any error a call
// failed with, so a callee's message broke its caller's stub for good.
import { DurableObject } from "cloudflare:workers";

const MARKERS = ["__CELLD_ACTOR_ABORT__:", "__CELLD_PROCESS_EXIT__:", "__CELLD_ACTOR_RESET__:"];
const TEXTS = MARKERS.flatMap((marker) => [marker + "x", "bad " + marker + "x"]);

async function attempt(fn) {
  try {
    return await fn();
  } catch (error) {
    return `${error.name}: ${error.message}`;
  }
}

export class Obj extends DurableObject {
  calls = 0;

  count() {
    this.calls += 1;
    return this.calls;
  }

  fail(text) {
    throw new Error(text);
  }

  fetch(request) {
    throw new Error(new URL(request.url).searchParams.get("text"));
  }
}

export default {
  async fetch(request, env) {
    const via = new URL(request.url).pathname.slice(1);
    const stub = env.OBJ.getByName(via);
    const out = { before: await attempt(() => stub.count()) };
    for (const text of TEXTS) {
      out[text] = via === "rpc"
        ? await attempt(() => stub.fail(text))
        // Only that it failed: the text a fetch() handler's error arrives
        // with is `rpc/do-fetch-throws`.
        : await stub.fetch(`http://x/?text=${encodeURIComponent(text)}`)
            .then(() => "answered", () => "threw");
      out[text + " then"] = await attempt(() => stub.count());
    }
    return Response.json(out);
  },
};
