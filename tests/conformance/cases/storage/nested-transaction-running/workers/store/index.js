// An outer transaction that tries to end while a transaction another event
// started inside it is still running (plan 1.14). Each scenario runs in its
// own object.
//
// Event "b" starts first (the fetch handler calls "a" only once "b" runs),
// waits for "a" to open its transaction, joins it with a transaction of its
// own, and tells "a" it is open. Then:
// - /rollback-while-child: "a" calls rollback() on its transaction. workerd
//   refuses while the nested transaction runs, and both commit.
// - /end-while-child: "a"'s callback returns. workerd fails the critical
//   section, which resets the object: both events fail, and no write
//   survives, including the ones "b" tries after the reset through each
//   storage surface.
// - /throw-while-child: "a"'s callback throws. "a" fails at once, while "b"
//   still waits for "a" to settle inside its transaction; "b" then commits,
//   and "a"'s rollback discards both writes.
// Each event's outcome is recorded as fulfilled or rejected: the error text
// of a reset differs (workerd reports an internal error).
import { DurableObject } from "cloudflare:workers";

const message = (error) => (error instanceof Error ? error.message : String(error));

export class Store extends DurableObject {
  order = [];
  aOpen = Promise.withResolvers();
  bOpen = Promise.withResolvers();
  aRolledBack = Promise.withResolvers();
  aSettled = Promise.withResolvers();
  bDone = Promise.withResolvers();
  bRunning = Promise.withResolvers();

  log(entry) {
    this.order.push(entry);
  }

  async bStarted() {
    await this.bRunning.promise;
  }

  async a(scenario) {
    try {
      await this.aTransaction(scenario);
    } finally {
      this.aSettled.resolve();
    }
  }

  async aTransaction(scenario) {
    const storage = this.ctx.storage;
    await storage.transaction(async (txn) => {
      await storage.put("a", "a");
      this.log("a:open");
      this.aOpen.resolve();
      await this.bOpen.promise;
      if (scenario === "end-while-child") return;
      if (scenario === "throw-while-child") throw new Error("a threw");
      try {
        txn.rollback();
        this.log("a:rolled-back");
      } catch (error) {
        this.log("a:rollback:" + message(error));
      }
      this.aRolledBack.resolve();
      await this.bDone.promise;
      this.log("a:end");
    });
    this.log("a:ok");
  }

  async b(scenario) {
    const storage = this.ctx.storage;
    this.bRunning.resolve();
    await this.aOpen.promise;
    try {
      await storage.transaction(async () => {
        this.log("b:open");
        await storage.put("b", "b");
        this.bOpen.resolve();
        if (scenario === "rollback-while-child") await this.aRolledBack.promise;
        if (scenario === "throw-while-child") {
          await this.aSettled.promise;
          this.log("b:saw-a-settled");
        }
        if (scenario === "end-while-child") {
          // After "a"'s transaction has failed and reset the object.
          await this.aSettled.promise;
          const late = [
            () => storage.put("late", "late"),
            () => storage.kv.put("late2", "late2"),
            () => storage.sql.exec("CREATE TABLE late (v TEXT)"),
            () => storage.transactionSync(() => storage.kv.put("late3", "late3")),
            () => storage.transaction(async () => storage.put("late4", "late4")),
          ];
          for (const write of late) {
            try {
              await write();
            } catch {}
          }
        }
        await storage.put("b2", "b2");
        this.log("b:end");
      });
      this.log("b:ok");
    } finally {
      this.bDone.resolve();
    }
  }

  async final() {
    const storage = this.ctx.storage;
    const keys = ["a", "b", "b2", "late", "late2", "late3", "late4"];
    const values = Object.fromEntries(
      await Promise.all(keys.map(async (key) => [key, (await storage.get(key)) ?? null])),
    );
    const tables = storage.sql
      .exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'late'")
      .toArray().length;
    return { ...values, lateTable: tables > 0, order: this.order };
  }
}

export default {
  async fetch(request, env) {
    const scenario = new URL(request.url).pathname.slice(1);
    if (!["rollback-while-child", "end-while-child", "throw-while-child"].includes(scenario))
      return new Response("not found", { status: 404 });
    try {
      const store = env.STORE.getByName(scenario);
      // "a" is called once "b" runs: two calls sent together can start in
      // either order.
      const b = store.b(scenario);
      await store.bStarted();
      const settled = await Promise.allSettled([b, store.a(scenario)]);
      const events = Object.fromEntries(settled.map((result, i) => [i === 0 ? "b" : "a", result.status]));
      // A fresh stub: the one above can be broken with the object.
      return Response.json({ events, final: await env.STORE.getByName(scenario).final() });
    } catch (error) {
      return Response.json({ error: message(error) }, { status: 500 });
    }
  },
};
