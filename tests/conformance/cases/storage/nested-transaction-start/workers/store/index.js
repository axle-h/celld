// When a transaction started inside another one starts, and where it goes
// (plan 1.14). workerd runs it as a nested critical section, which starts
// once the current turn has ended, and only then nests it inside the
// innermost transaction still open, or runs it on its own. Each scenario runs
// in its own object and answers what the storage holds afterwards and the
// order things ran in.
//
// The two-event scenarios start event "b" first (the fetch handler calls "a"
// only once "b" runs); "b" waits on a promise that "a" resolves from inside
// its open transaction, so "b" resumes while that transaction is open.
// - /same-turn, /same-turn-throw: "a"'s callback returns (or throws) in the
//   turn "b" resumes in and starts its transaction, so "b"'s transaction runs
//   on its own once "a"'s has ended.
// - /async-in-sync: "b" joins with transactionSync() and starts an
//   asynchronous transaction inside its callback. That one starts after the
//   synchronous one has ended, inside "a"'s transaction.
// - /sync-in-joined: synchronous transactions inside a joined asynchronous
//   one; the first throws.
// One-event scenarios:
// - /siblings: two transactions started together inside one run one after
//   the other.
// - /unawaited: a transaction started and not awaited inside one whose
//   callback then returns runs after the outer one has committed.
// - /nested-block: blockConcurrencyWhile() inside another starts its callback
//   after the current turn.
// - /view: the transaction callback's argument has no transaction().
import { DurableObject } from "cloudflare:workers";

const message = (error) => (error instanceof Error ? error.message : String(error));

export class Store extends DurableObject {
  order = [];
  aOpen = Promise.withResolvers();
  bDone = Promise.withResolvers();
  bRunning = Promise.withResolvers();

  log(entry) {
    this.order.push(entry);
  }

  async bStarted() {
    await this.bRunning.promise;
  }

  async a(scenario) {
    const storage = this.ctx.storage;
    try {
      await storage.transaction(async () => {
        await storage.put("a", "a");
        this.log("a:open");
        this.aOpen.resolve();
        if (scenario === "same-turn") return;
        if (scenario === "same-turn-throw") throw new Error("a threw");
        await this.bDone.promise;
        this.log("a:end");
      });
      this.log("a:ok");
    } catch (error) {
      this.log("a:err:" + message(error));
    }
  }

  async b(scenario) {
    const storage = this.ctx.storage;
    this.bRunning.resolve();
    await this.aOpen.promise;
    this.log("b:resumed");
    try {
      if (scenario === "async-in-sync") {
        let started;
        storage.transactionSync(() => {
          storage.kv.put("s", "s");
          started = storage.transaction(async () => {
            this.log("c:open");
            await storage.put("c", "c");
          });
          this.log("sync:end");
        });
        await started;
        this.log("c:ok");
      } else if (scenario === "sync-in-joined") {
        await storage.transaction(async () => {
          await storage.put("b", "b");
          try {
            storage.transactionSync(() => {
              storage.kv.put("s", "s");
              throw new Error("sync failed");
            });
          } catch (error) {
            this.log("sync:" + message(error));
          }
          storage.transactionSync(() => storage.kv.put("s2", "s2"));
        });
      } else {
        await storage.transaction(async () => {
          this.log("b:open");
          await storage.put("b", "b");
        });
      }
      this.log("b:ok");
    } catch (error) {
      this.log("b:err:" + message(error));
    }
    this.bDone.resolve();
  }

  async siblings() {
    const storage = this.ctx.storage;
    await storage.transaction(async () => {
      this.log("outer:open");
      const inner = (tag) =>
        storage.transaction(async () => {
          this.log(tag + ":open");
          await storage.put(tag, tag);
          await Promise.resolve();
          this.log(tag + ":end");
        });
      await Promise.all([inner("x"), inner("y")]);
      this.log("outer:end");
    });
  }

  async unawaited() {
    const storage = this.ctx.storage;
    let started;
    await storage.transaction(async () => {
      await storage.put("outer", "outer");
      started = storage.transaction(async () => {
        this.log("inner:open");
        await storage.put("inner", "inner");
      });
      this.log("outer:end");
    });
    this.log("outer:ok");
    await started;
    this.log("inner:ok");
  }

  async nestedBlock() {
    await this.ctx.blockConcurrencyWhile(async () => {
      this.log("outer:start");
      const inner = this.ctx.blockConcurrencyWhile(async () => this.log("inner"));
      this.log("outer:called");
      await Promise.resolve();
      this.log("outer:after-microtask");
      await inner;
      this.log("outer:end");
    });
  }

  async view() {
    let type;
    await this.ctx.storage.transaction(async (txn) => {
      type = typeof txn.transaction;
    });
    return type;
  }

  async final() {
    const storage = this.ctx.storage;
    const keys = ["a", "b", "c", "s", "s2", "x", "y", "outer", "inner"];
    const values = Object.fromEntries(
      await Promise.all(keys.map(async (key) => [key, (await storage.get(key)) ?? null])),
    );
    return { ...values, order: this.order };
  }
}

const SINGLE = { "siblings": "siblings", "unawaited": "unawaited", "nested-block": "nestedBlock" };

export default {
  async fetch(request, env) {
    const scenario = new URL(request.url).pathname.slice(1);
    const store = env.STORE.getByName(scenario);
    try {
      if (scenario === "view") return Response.json({ type: await store.view() });
      if (SINGLE[scenario]) {
        await store[SINGLE[scenario]]();
      } else if (["same-turn", "same-turn-throw", "async-in-sync", "sync-in-joined"].includes(scenario)) {
        // "a" is called once "b" runs: two calls sent together can start in
        // either order.
        const b = store.b(scenario);
        await store.bStarted();
        await Promise.all([b, store.a(scenario)]);
      } else {
        return new Response("not found", { status: 404 });
      }
      return Response.json(await store.final());
    } catch (error) {
      return Response.json({ error: message(error) }, { status: 500 });
    }
  },
};
