// Transactions opened on the root `ctx.storage` while another transaction is
// open (plan 1.14, denoland/celld#226). Each scenario runs in its own object
// and answers what the storage holds afterwards; `null` is an absent key.
import { DurableObject } from "cloudflare:workers";

const message = (error) => (error instanceof Error ? error.message : String(error));

export class Store extends DurableObject {
  read(keys) {
    return Object.fromEntries(keys.map((key) => [key, this.ctx.storage.kv.get(key) ?? null]));
  }

  // A helper that reaches the root storage starts its own synchronous
  // transaction inside an open one.
  nestedSync() {
    const storage = this.ctx.storage;
    storage.transactionSync(() => {
      storage.kv.put("outer", 1);
      storage.transactionSync(() => storage.kv.put("inner", 2));
    });
    return this.read(["outer", "inner"]);
  }

  nestedSyncRollback() {
    const storage = this.ctx.storage;
    let caught = null;
    storage.transactionSync(() => {
      storage.kv.put("outer", 1);
      try {
        storage.transactionSync(() => {
          storage.kv.put("inner", 2);
          throw new Error("inner failed");
        });
      } catch (error) {
        caught = message(error);
      }
    });
    return { caught, ...this.read(["outer", "inner"]) };
  }

  async nestedAsync() {
    const storage = this.ctx.storage;
    await storage.transaction(async () => {
      await storage.put("outer", 1);
      await storage.transaction(async () => {
        await storage.put("inner", 2);
      });
    });
    return this.read(["outer", "inner"]);
  }

  // The inner transaction commits and the outer one then fails: a nested
  // transaction is part of the outer one, so neither write survives.
  nestedSyncOuterRollback() {
    const storage = this.ctx.storage;
    let caught = null;
    try {
      storage.transactionSync(() => {
        storage.kv.put("outer", 1);
        storage.transactionSync(() => storage.kv.put("inner", 2));
        throw new Error("outer failed");
      });
    } catch (error) {
      caught = message(error);
    }
    return { caught, ...this.read(["outer", "inner"]) };
  }

  async nestedAsyncOuterRollback() {
    const storage = this.ctx.storage;
    let caught = null;
    try {
      await storage.transaction(async () => {
        await storage.put("outer", 1);
        await storage.transaction(async () => {
          await storage.put("inner", 2);
        });
        throw new Error("outer failed");
      });
    } catch (error) {
      caught = message(error);
    }
    return { caught, ...this.read(["outer", "inner"]) };
  }

  // The inner transaction fails by throwing, and a second one by rollback().
  async nestedAsyncRollback() {
    const storage = this.ctx.storage;
    let caught = null;
    await storage.transaction(async () => {
      await storage.put("outer", 1);
      try {
        await storage.transaction(async () => {
          await storage.put("thrown", 2);
          throw new Error("inner failed");
        });
      } catch (error) {
        caught = message(error);
      }
      await storage.transaction(async (inner) => {
        await storage.put("rolledBack", 3);
        inner.rollback();
      });
    });
    return { caught, ...this.read(["outer", "thrown", "rolledBack"]) };
  }

  // A synchronous transaction on the root inside an asynchronous one.
  async asyncOuterSyncInnerRollback() {
    const storage = this.ctx.storage;
    let caught = null;
    await storage.transaction(async () => {
      await storage.put("outer", 1);
      try {
        storage.transactionSync(() => {
          storage.kv.put("inner", 2);
          throw new Error("inner failed");
        });
      } catch (error) {
        caught = message(error);
      }
    });
    return { caught, ...this.read(["outer", "inner"]) };
  }

  // One event of two sent at once. Each opens an asynchronous transaction on
  // the root, waits on a timer inside it, and reads through the root. Both
  // runtimes run the two one after the other: the transaction holds the
  // input gate, so the second event starts only when the first has settled.
  // "order" pins that. "a" rolls back, so "b" never sees its write.
  // storage/inflight-event-* covers an event that runs while another's
  // transaction is open.
  async concurrent(tag, rollback) {
    const storage = this.ctx.storage;
    this.trace ??= [];
    let seen = null;
    let caught = null;
    try {
      await storage.transaction(async () => {
        await storage.put(tag, tag);
        this.trace.push(`${tag}:open`);
        await scheduler.wait(20);
        this.trace.push(`${tag}:after-wait`);
        seen = { a: (await storage.get("a")) ?? null, b: (await storage.get("b")) ?? null };
        if (rollback) throw new Error(`${tag} rolled back`);
      });
    } catch (error) {
      caught = message(error);
    }
    return { tag, seen, caught };
  }

  readTrace() {
    return this.trace ?? [];
  }
}

const SCENARIOS = {
  "/nested-sync": (store) => store.nestedSync(),
  "/nested-sync-rollback": (store) => store.nestedSyncRollback(),
  "/nested-async": (store) => store.nestedAsync(),
  "/nested-async-rollback": (store) => store.nestedAsyncRollback(),
  "/async-outer-sync-inner-rollback": (store) => store.asyncOuterSyncInnerRollback(),
  "/nested-sync-outer-rollback": (store) => store.nestedSyncOuterRollback(),
  "/nested-async-outer-rollback": (store) => store.nestedAsyncOuterRollback(),
  "/concurrent": async (store) => {
    const events = await Promise.all([store.concurrent("a", true), store.concurrent("b", false)]);
    return { events, order: await store.readTrace(), final: await store.read(["a", "b"]) };
  },
};

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    const scenario = SCENARIOS[pathname];
    if (!scenario) return new Response("not found", { status: 404 });
    try {
      return Response.json(await scenario(env.STORE.getByName(pathname)));
    } catch (error) {
      return Response.json({ error: message(error) }, { status: 500 });
    }
  },
};
