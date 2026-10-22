// An event that is already running when another event opens a transaction on
// the root storage, and that then starts a transaction of its own while the
// first is open (plan 1.14, denoland/celld#226).
//
// Event "b" starts first (the fetch handler calls "a" only once "b" runs)
// and waits on a promise that event "a" resolves from inside its open
// transaction. So "b" resumes while "a"'s transaction is open without any
// timer or I/O, which the input gate would hold back. "b" then
// opens a transaction (/async: transaction(), /sync: transactionSync()) and
// writes "b"; "a" later rolls back. The transcript records what each event
// saw, the order things ran in, and what the storage holds at the end.
//
// A timer instead of the promise makes workerd 1.20261001.1 deadlock: "b"'s
// timer waits on the input gate that "a"'s transaction holds, and "a"'s
// later timer waits behind it, until blockConcurrencyWhile gives up after 30s.
import { DurableObject } from "cloudflare:workers";

const message = (error) => (error instanceof Error ? error.message : String(error));

export class Store extends DurableObject {
  order = [];
  opened = Promise.withResolvers();
  bRunning = Promise.withResolvers();

  async bStarted() {
    await this.bRunning.promise;
  }

  async a() {
    const storage = this.ctx.storage;
    let seen = null;
    let caught = null;
    try {
      await storage.transaction(async () => {
        await storage.put("a", "a");
        this.order.push("a:open");
        this.opened.resolve();
        await scheduler.wait(50);
        this.order.push("a:after-wait");
        seen = { a: (await storage.get("a")) ?? null, b: (await storage.get("b")) ?? null };
        throw new Error("a rolled back");
      });
    } catch (error) {
      caught = message(error);
    }
    return { tag: "a", seen, caught };
  }

  async b(sync) {
    const storage = this.ctx.storage;
    let seen = null;
    let caught = null;
    this.order.push("b:waiting");
    this.bRunning.resolve();
    await this.opened.promise;
    this.order.push("b:resumed");
    try {
      if (sync) {
        storage.transactionSync(() => {
          storage.kv.put("b", "b");
          this.order.push("b:open");
          seen = { a: storage.kv.get("a") ?? null, b: storage.kv.get("b") ?? null };
        });
      } else {
        await storage.transaction(async () => {
          await storage.put("b", "b");
          this.order.push("b:open");
          seen = { a: (await storage.get("a")) ?? null, b: (await storage.get("b")) ?? null };
        });
      }
    } catch (error) {
      caught = message(error);
    }
    return { tag: "b", seen, caught };
  }

  final() {
    return { a: this.ctx.storage.kv.get("a") ?? null, b: this.ctx.storage.kv.get("b") ?? null, order: this.order };
  }
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname !== "/async" && pathname !== "/sync") return new Response("not found", { status: 404 });
    const store = env.STORE.getByName(pathname);
    try {
      // "a" is called once "b" runs: two calls sent together can start in
      // either order.
      const b = store.b(pathname === "/sync");
      await store.bStarted();
      const events = await Promise.all([b, store.a()]);
      return Response.json({ events, final: await store.final() });
    } catch (error) {
      return Response.json({ error: message(error) }, { status: 500 });
    }
  },
};
