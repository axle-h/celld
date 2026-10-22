import { WorkerEntrypoint } from "cloudflare:workers";

let ran = null;

export default class extends WorkerEntrypoint {
  async fetch() {
    const result = await this.env.SELF.scheduled({ cron: "5 * * * *", scheduledTime: 1000 });
    return Response.json({
      scheduledType: typeof this.env.SELF.scheduled,
      queueType: typeof this.env.SELF.queue,
      result,
      ran,
      reported: Cloudflare.compatibilityFlags.service_binding_extra_handlers,
    });
  }
  scheduled(controller) {
    ran = { cron: controller.cron, scheduledTime: controller.scheduledTime };
  }
}
