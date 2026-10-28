// One Durable Object's storage, used during another object's event in the
// same isolate (plan 1.49). As in workerd, every storage and alarm
// operation refuses with the cross-object error, and nothing reaches the
// other object's data. Object "a" then uses its own storage.
import { DurableObject } from "cloudflare:workers";

const leaked = {};

export class Store extends DurableObject {
  alarm() {}

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/hold")) {
      leaked.storage = this.ctx.storage;
      await this.ctx.storage.put("k", "a's value");
      this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS t(n)");
      this.ctx.storage.sql.exec("INSERT INTO t VALUES (1), (2), (3)");
      // A cursor advanced once, so its second row is buffered one step ahead.
      leaked.sqlCursor = this.ctx.storage.sql.exec("SELECT n FROM t ORDER BY n");
      leaked.sqlFirst = leaked.sqlCursor.next().value;
      // A kv.list() iterator advanced once, inside its transaction.
      this.ctx.storage.transactionSync(() => {
        leaked.listIter = this.ctx.storage.kv.list();
        leaked.listFirst = leaked.listIter.next().value;
      });
      return new Response("held");
    }
    const { storage } = leaked;
    const outcome = {};
    for (const [name, use] of Object.entries({
      get: () => storage.get("k"),
      getMany: () => storage.get(["k"]).then((map) => [...map]),
      put: () => storage.put("k", "other value"),
      delete: () => storage.delete("k"),
      list: () => storage.list().then((map) => [...map]),
      getAlarm: () => storage.getAlarm(),
      setAlarm: () => storage.setAlarm(Date.now() + 60_000),
      deleteAlarm: () => storage.deleteAlarm(),
      kvGet: () => storage.kv.get("k"),
      sql: () => storage.sql.exec("SELECT 1 AS one").toArray(),
      databaseSize: () => typeof storage.sql.databaseSize,
      transactionSync: () => storage.transactionSync(() => "ran"),
    })) {
      try {
        outcome[name] = (await use()) ?? "ok";
      } catch (error) {
        outcome[name] = `${error.name}: ${error.message}`;
      }
    }
    // The leaked cursors are read once, by object "b": a cursor is an I/O
    // object of the object that opened it, and "b" is a different one. (Only
    // once: workerd also invalidates "a"'s own kv.list() iterator when its
    // transaction ends, a difference unrelated to cross-object ownership.)
    if (!leaked.cursorsProbed) {
      leaked.cursorsProbed = true;
      for (const [name, use] of Object.entries({
        sqlCursor: () => leaked.sqlCursor.next().value,
        listCursor: () => leaked.listIter.next().value,
      })) {
        try {
          outcome[name] = use() ?? "ok";
        } catch (error) {
          outcome[name] = `${error.name}: ${error.message}`;
        }
      }
    }
    return Response.json(outcome);
  }
}

export default {
  fetch(request, env) {
    const name = new URL(request.url).pathname.split("/")[1];
    return env.STORE.getByName(name).fetch(request);
  },
};
