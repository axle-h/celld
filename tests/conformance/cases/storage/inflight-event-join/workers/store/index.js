// An event already in flight that joins another event's open transaction on
// the root storage (plan 1.14). storage/inflight-event-{async,sync}-transaction
// pin the join and the outer rollback discarding both writes. Here the outer
// transaction commits, and the joined one commits (/commit), throws (/throw,
// /sync-throw), rolls back (/rollback), or throws after the outer event wrote
// while the joined one was the innermost open layer (/interleaved). Each
// scenario runs in its own object.
//
// Event "b" starts first (the fetch handler calls "a" only once "b" runs) and
// waits on a promise that event "a" resolves from inside its open
// transaction, so "b" resumes while that transaction is open.
// "a" then waits for "b" to settle before it commits. The events hand control
// to each other through promises only: a timer in either one deadlocks workerd
// 1.20261001.1 (see storage/inflight-event-*).
import { DurableObject } from "cloudflare:workers";

const message = (error) => (error instanceof Error ? error.message : String(error));

export class Store extends DurableObject {
  order = [];
  aOpen = Promise.withResolvers();
  bOpen = Promise.withResolvers();
  aWrote = Promise.withResolvers();
  bDone = Promise.withResolvers();
  bRunning = Promise.withResolvers();

  async bStarted() {
    await this.bRunning.promise;
  }

  async read(...keys) {
    const storage = this.ctx.storage;
    return Object.fromEntries(await Promise.all(keys.map(async (key) => [key, (await storage.get(key)) ?? null])));
  }

  // The outer transaction, which commits.
  async a(scenario) {
    const storage = this.ctx.storage;
    let seen = null;
    let caught = null;
    try {
      await storage.transaction(async () => {
        await storage.put("a", "a");
        this.order.push("a:open");
        this.aOpen.resolve();
        if (scenario === "interleaved") {
          // Write while "b"'s joined transaction is the innermost open one.
          await this.bOpen.promise;
          await storage.put("a2", "a2");
          this.order.push("a:wrote-a2");
          this.aWrote.resolve();
        }
        await this.bDone.promise;
        this.order.push("a:end");
        seen = await this.read("a", "a2", "b");
      });
    } catch (error) {
      caught = message(error);
    }
    this.order.push("a:settled");
    return { tag: "a", seen, caught };
  }

  async b(scenario) {
    const storage = this.ctx.storage;
    let seen = null;
    let caught = null;
    this.bRunning.resolve();
    await this.aOpen.promise;
    this.order.push("b:resumed");
    try {
      if (scenario === "sync-throw") {
        storage.transactionSync(() => {
          storage.kv.put("b", "b");
          seen = { a: storage.kv.get("a") ?? null, b: storage.kv.get("b") ?? null };
          throw new Error("b failed");
        });
      } else {
        await storage.transaction(async (txn) => {
          await storage.put("b", "b");
          this.order.push("b:open");
          if (scenario === "interleaved") {
            this.bOpen.resolve();
            await this.aWrote.promise;
          }
          seen = await this.read("a", "a2", "b");
          if (scenario === "throw" || scenario === "interleaved") throw new Error("b failed");
          if (scenario === "rollback") txn.rollback();
        });
      }
    } catch (error) {
      caught = message(error);
    }
    this.order.push("b:settled");
    this.bDone.resolve();
    return { tag: "b", seen, caught };
  }

  async final() {
    return { ...(await this.read("a", "a2", "b")), order: this.order };
  }
}

export default {
  async fetch(request, env) {
    const scenario = new URL(request.url).pathname.slice(1);
    if (!["commit", "throw", "sync-throw", "rollback", "interleaved"].includes(scenario))
      return new Response("not found", { status: 404 });
    const store = env.STORE.getByName(scenario);
    try {
      // "a" is called once "b" runs: two calls sent together can start in
      // either order.
      const b = store.b(scenario);
      await store.bStarted();
      const events = await Promise.all([b, store.a(scenario)]);
      return Response.json({ events, final: await store.final() });
    } catch (error) {
      return Response.json({ error: message(error) }, { status: 500 });
    }
  },
};
