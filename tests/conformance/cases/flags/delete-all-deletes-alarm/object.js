// Whether storage.deleteAll() also deletes the alarm, which
// delete_all_deletes_alarm decides (on from 2026-02-24).
import { DurableObject } from "cloudflare:workers";

export class Base extends DurableObject {
  async run() {
    await this.ctx.storage.put("key", 1);
    await this.ctx.storage.setAlarm(Date.now() + 3_600_000);
    const before = (await this.ctx.storage.getAlarm()) !== null;
    await this.ctx.storage.deleteAll();
    return {
      alarmBefore: before,
      alarmAfter: (await this.ctx.storage.getAlarm()) !== null,
      key: (await this.ctx.storage.get("key")) ?? null,
    };
  }
  alarm() {}
}

export async function report(env) {
  const stub = env.OBJECT.get(env.OBJECT.idFromName("one"));
  return Response.json({
    ...(await stub.run()),
    reported: Cloudflare.compatibilityFlags.delete_all_deletes_alarm,
  });
}
