// An alarm() handler that leaves an INSERT … RETURNING cursor read in part
// (plan 1.30). Its turn cannot commit, which resets the object: on workerd
// the run counts as failed and the alarm retries after its backoff, and the
// object answers its next call. celld retried at once, without end, when the
// reset rolled back the host's own deletion of the alarm with the handler's
// writes.
import { DurableObject } from "cloudflare:workers";

let fired = 0;

export class Obj extends DurableObject {
  async arm() {
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS t (v)");
    // Far enough out that this call has answered before the alarm resets
    // the object, however slow the machine.
    await this.ctx.storage.setAlarm(Date.now() + 500);
    return "armed";
  }

  alarm() {
    fired += 1;
    this.cursor = this.ctx.storage.sql.exec("INSERT INTO t VALUES (1), (2) RETURNING v");
    this.cursor.next();
  }

  async check() {
    return { fired, alarm: (await this.ctx.storage.getAlarm()) === null ? null : "set" };
  }
}

export default {
  async fetch(request, env) {
    try {
      if (new URL(request.url).pathname === "/arm")
        return Response.json(await env.OBJ.getByName("a").arm());
      // The first run, and one retry after workerd's 2-second backoff; the
      // next retry waits 4 seconds more. Bounded: 15 s.
      for (let attempt = 0; attempt < 150; attempt++) {
        if ((await env.OBJ.getByName("a").check()).fired >= 2) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return Response.json(await env.OBJ.getByName("a").check());
    } catch (error) {
      return Response.json("threw " + error.message);
    }
  },
};
