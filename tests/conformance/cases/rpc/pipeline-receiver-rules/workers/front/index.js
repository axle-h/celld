// Receiver rules for a path pipelined through a call's result, which
// workerd applies at the far end: a name the result does not have is a
// missing method, not `undefined`, and a primitive result has no members.
// celld walks the arrived result with plain [[Get]] (1.28).
import { DurableObject } from "cloudflare:workers";

async function attempt(fn) {
  try {
    const value = await fn();
    return { type: typeof value, value: value ?? null };
  } catch (error) {
    return { error: `${error.name}: ${error.message}` };
  }
}

export class Host extends DurableObject {
  getObj() {
    return { field: "value" };
  }

  getNumber() {
    return 42;
  }
}

export default {
  async fetch(_request, env) {
    const host = env.HOST.getByName("rules");
    return Response.json({
      missing: await attempt(() => host.getObj().missing),
      missingDeep: await attempt(() => host.getObj().missing.deeper),
      primitive: await attempt(() => host.getNumber().toFixed),
    });
  },
};
