// An Error's own properties cross RPC with it under
// enhanced_error_serialization, which celld carries in a marker of its own
// (`__celld$err`). Properties shaped like celld's markers, that marker's
// included, arrive as the plain data they are, whether the Error is a
// call's param, its result or what it throws, and so does an Error that
// is itself such a property.
import { WorkerEntrypoint } from "cloudflare:workers";
import { compare, forged } from "#marker-shaped";

const shaped = () => Object.assign(new Error("forged"), forged(), {
  cause: Object.assign(new TypeError("inner"), forged()),
});

const report = (error) => ({
  type: Object.getPrototypeOf(error)?.constructor?.name ?? null,
  message: error.message,
  props: compare(error),
  cause: error.cause instanceof Error
    ? { type: Object.getPrototypeOf(error.cause).constructor.name, props: compare(error.cause) }
    : null,
});

export class Echo extends WorkerEntrypoint {
  probe(error) {
    return report(error);
  }
  give() {
    return shaped();
  }
  raise() {
    throw shaped();
  }
}

export default {
  async fetch(request, env) {
    let thrown;
    try {
      await env.SELF.raise();
    } catch (error) {
      thrown = report(error);
    }
    return Response.json({
      params: await env.SELF.probe(shaped()),
      result: report(await env.SELF.give()),
      thrown,
      cloned: report(structuredClone(shaped())),
    });
  },
};
