// A reset whose error is hostile still resets (plan 1.30): a
// blockConcurrencyWhile() callback that throws an Error with a throwing
// enumerable getter or an Error with a very long stack (a revoked Proxy is
// `storage/reset-revoked-error`), and
// ctx.abort() called deep in a recursion with a long stack limit, or with a
// reason whose toString() throws, and both kinds of reset while the script
// has made `Error.prototype.name` throw and replaced `Uint8Array` and
// `%TypedArray%.prototype.set` (`patched`; the object's next call restores
// them). The write the turn made before the reset
// is discarded, a transaction it left open does not hold the next one off,
// the stub that saw the reset stays broken, and a fresh stub reaches a new
// instance. celld recorded the reset's error first, and a throw there left
// the reset half done.
import { DurableObject } from "cloudflare:workers";

// Only the message, through no prototype: a script that shares the isolate
// with the object (the patched rows) sees its patches until they are undone.
const message = (error) => {
  try {
    const own = Object.getOwnPropertyDescriptor(error, "message");
    return typeof own?.value === "string" ? own.value.slice(0, 40) : typeof error;
  } catch {
    return "unreadable";
  }
};

async function attempt(fn) {
  try {
    return await fn();
  } catch (error) {
    return "threw " + message(error);
  }
}

const LONG = "x".repeat(4000);

// Patches the builtins an envelope could be built with; `restore` undoes
// them. An abort ends the call before it could, so the next call does.
let restore = null;
const patch = () => {
  const TypedArray = Object.getPrototypeOf(Uint8Array.prototype);
  const set = TypedArray.set;
  const name = Object.getOwnPropertyDescriptor(Error.prototype, "name");
  const OriginalUint8Array = globalThis.Uint8Array;
  TypedArray.set = function () {
    throw new Error("set patched");
  };
  Object.defineProperty(Error.prototype, "name", {
    configurable: true,
    get() {
      throw new Error("name patched");
    },
  });
  globalThis.Uint8Array = function () {
    throw new Error("Uint8Array patched");
  };
  restore = () => {
    TypedArray.set = set;
    Object.defineProperty(Error.prototype, "name", name);
    globalThis.Uint8Array = OriginalUint8Array;
    restore = null;
  };
};
// A recursion through functions with 4000-character names, so a stack of
// 1000 frames runs to megabytes.
const deep = (depth, done) => {
  const named = { [LONG + depth]: () => (depth === 0 ? done() : deep(depth - 1, done)) };
  return named[LONG + depth]();
};

function hostile(kind) {
  if (kind === "getter") {
    const error = new Error("getter");
    Object.defineProperty(error, "boom", { enumerable: true, get() { throw new Error("read"); } });
    return error;
  }
  if (kind === "patched") return new Error("patched");
  Error.stackTraceLimit = 1000;
  try {
    return deep(300, () => new Error("deep"));
  } finally {
    Error.stackTraceLimit = 10;
  }
}

export class Obj extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS t (v TEXT)");
  }

  async reset(how, kind) {
    this.ctx.storage.sql.exec("INSERT INTO t VALUES ('doomed')");
    if (how === "block") {
      const error = hostile(kind);
      if (kind === "patched") patch();
      try {
        await this.ctx.blockConcurrencyWhile(async () => {
          throw error;
        });
      } finally {
        restore?.();
      }
      return "block returned";
    }
    if (kind === "patched") {
      patch();
      this.ctx.abort("patched");
      return "abort returned";
    }
    if (kind === "hostile-reason") {
      try {
        this.ctx.abort({ toString() { throw new Error("no text"); } });
      } catch (error) {
        return "abort threw " + message(error);
      }
      return "abort returned";
    }
    Error.stackTraceLimit = 1000;
    try {
      deep(300, () => this.ctx.abort("deep"));
    } finally {
      Error.stackTraceLimit = 10;
    }
    return "abort returned";
  }

  count() {
    restore?.();
    return this.ctx.storage.sql.exec("SELECT count(*) AS n FROM t").one().n;
  }

  async write() {
    restore?.();
    await this.ctx.storage.transaction(async () => {
      this.ctx.storage.sql.exec("INSERT INTO t VALUES ('later')");
    });
    return "written";
  }
}

export default {
  async fetch(request, env) {
    const [, how, kind] = new URL(request.url).pathname.split("/");
    const name = `${how}-${kind}`;
    const stub = env.OBJ.getByName(name);
    const before = await attempt(() => stub.count());
    const reset = await attempt(() => stub.reset(how, kind));
    const stale = await attempt(() => stub.count());
    const fresh = env.OBJ.getByName(name);
    return Response.json({
      before,
      reset,
      stale,
      rows: await attempt(() => fresh.count()),
      write: await attempt(() => fresh.write()),
      after: await attempt(() => fresh.count()),
    });
  },
};
