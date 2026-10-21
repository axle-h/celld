// The same probe as the primary's /ctx, under allow_irrevocable_stub_storage.
// The class name differs from the primary's: celld refuses one DO class name
// exported by two co-hosted scripts (plan item 2.4).
import { DurableObject } from "cloudflare:workers";

export class FlaggedProbe extends DurableObject {
  restoreType() {
    return typeof this.ctx.restore;
  }
}

export default {
  async fetch(request, env, ctx) {
    return Response.json({
      flag: Cloudflare.compatibilityFlags.allow_irrevocable_stub_storage,
      execution: typeof ctx.restore,
      durableObject: await env.PROBE.getByName("probe").restoreType(),
    });
  },
};
