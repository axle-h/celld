// setAlarm() while an INSERT … RETURNING cursor has been read in part
// (plan 1.59, found by the 1.30 review). workerd fails the call with an
// internal error when the turn's commit finds the statement still running,
// resets the object and discards the write; celld refuses the setAlarm()
// and the output ("unfinished SQL write cursor"), and resets the object as
// the turn ends: only the call's text differs.
import { DurableObject } from "cloudflare:workers";

let fired = 0;

export class Obj extends DurableObject {
  async set() {
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS t (v)");
    this.cursor = this.ctx.storage.sql.exec("INSERT INTO t VALUES (1), (2) RETURNING v");
    this.cursor.next();
    try {
      await this.ctx.storage.setAlarm(Date.now() + 50);
      return "set";
    } catch (error) {
      return "setAlarm threw " + error.message;
    }
  }

  alarm() {
    fired += 1;
  }

  async check() {
    return {
      fired,
      alarm: await this.ctx.storage.getAlarm(),
      rows: this.ctx.storage.sql.exec("SELECT count(*) AS n FROM t").one().n,
    };
  }
}

export default {
  async fetch(request, env) {
    try {
      if (new URL(request.url).pathname === "/set")
        return Response.json(await env.OBJ.getByName("a").set());
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return Response.json(await env.OBJ.getByName("a").check());
    } catch (error) {
      return Response.json("threw " + error.message);
    }
  },
};
