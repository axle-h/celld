// durable_object_io_tasks_prevent_eviction: a Durable Object whose
// waitUntil() work is pending stays in memory after its client has its
// answer (on Cloudflare for up to 15 minutes; workerd run locally does not
// evict it either). celld behaves as without the flag: a request's activity
// ends with its answer, so idle eviction takes the object with its work
// pending, which is lost (plan 1.64). The case's env makes celld evict an
// idle object after 1 s.
import { DurableObject } from "cloudflare:workers";

export class Holder extends DurableObject {
  start(work) {
    this.memory = "held";
    if (work) this.ctx.waitUntil(scheduler.wait(4000).then(() => { this.finished = true; }));
    return "started";
  }
  check() {
    return { memory: this.memory ?? "new instance", finished: this.finished ?? false };
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const stub = env.HOLDER.getByName(url.pathname);
    await stub.start(url.pathname === "/pending");
    await scheduler.wait(3000);
    const early = await stub.check();
    await scheduler.wait(1500);
    return Response.json({
      early,
      reported: Cloudflare.compatibilityFlags.durable_object_io_tasks_prevent_eviction ?? null,
    });
  },
};
