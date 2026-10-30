// What an Error keeps through structuredClone(), RPC and storage. With
// enhanced_error_serialization an Error's own properties cross with it, as a
// host object of workerd's serializer (jsg/ser.c++); without it V8 carries
// its name (a standard one), message, stack and cause.
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

class MyError extends Error {
  constructor(message) {
    super(message);
    this.name = "MyError";
    this.extra = 1;
  }
}
class Unnamed extends Error {}

export const ERRORS = {
  plain: () => new Error("plain"),
  typed: () => new TypeError("typed"),
  range: () => new RangeError("range"),
  props: () => Object.assign(new Error("props"), { code: "E_X", status: 418, detail: { a: [1, { b: 2 }] } }),
  named: () => Object.assign(new Error("named"), { name: "CustomName" }),
  subclass: () => new MyError("subclass"),
  unnamedSubclass: () => new Unnamed("unnamed"),
  cause: () => new Error("outer", { cause: new RangeError("inner") }),
  causeValue: () => new Error("outer", { cause: { plain: true } }),
  aggregate: () => new AggregateError([new Error("a"), 1], "aggregate"),
  getter: () => Object.defineProperty(new Error("getter"), "computed", { get: () => 5, enumerable: true }),
  hidden: () => Object.defineProperty(new Error("hidden"), "secret", { value: "s", enumerable: false }),
  symbol: () => Object.assign(new Error("symbol"), { [Symbol("s")]: 1 }),
  index: () => Object.assign(new Error("index"), { 0: "zero", key: "value" }),
  stack: () => Object.assign(new Error("stack"), { stack: "custom stack" }),
  function: () => Object.assign(new Error("function"), { fn: () => 1 }),
  nestedError: () => Object.assign(new Error("nested"), { inner: new TypeError("inside") }),
  protoKey: () => Object.defineProperty(new Error("proto"), "__proto__", { value: { polluted: true }, enumerable: true }),
  selfReference: () => {
    const error = new Error("self");
    error.self = error;
    return error;
  },
  domNamed: () => Object.assign(new Error("aborted"), { name: "DOMException(AbortError)" }),
  string: () => "a string",
  object: () => ({ thrown: "object" }),
  null: () => null,
};

const firstLine = (stack) => typeof stack === "string" ? stack.split("\n")[0] : typeof stack;

export function describe(value, depth = 0) {
  if (!(value instanceof Error) && !(value instanceof DOMException)) {
    return { value: typeof value === "object" && value !== null ? JSON.stringify(value) : String(value) };
  }
  // A DOMException's own `code` is rpc/error-shapes' (plan 1.63).
  const own = Reflect.ownKeys(value).map(String).filter((key) => !(value instanceof DOMException && key === "code")).sort();
  const out = {
    type: Object.getPrototypeOf(value)?.constructor?.name ?? null,
    name: value.name,
    message: value.message,
    own,
    stack: firstLine(value.stack),
  };
  if (value instanceof DOMException) out.code = value.code;
  for (const key of own) {
    if (["name", "message", "stack", "cause", "errors"].includes(key)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    const v = descriptor?.value;
    out[`prop ${key}`] = descriptor?.get ? "getter"
      : v instanceof Error ? (depth < 2 ? describe(v, depth + 1) : "error")
        : typeof v === "object" && v !== null ? JSON.stringify(v) : String(v);
  }
  if ("cause" in value) out.cause = value.cause instanceof Error ? describe(value.cause, depth + 1) : JSON.stringify(value.cause);
  if (Array.isArray(value.errors)) out.errors = value.errors.map((e) => describe(e, depth + 1));
  if (Object.getPrototypeOf(value) !== null && Object.getPrototypeOf(value).polluted) out.polluted = true;
  return out;
}

const attempt = async (run) => {
  try {
    return { ok: describe(await run()) };
  } catch (error) {
    return { threw: describe(error) };
  }
};

export class Errors extends WorkerEntrypoint {
  give(kind) { return ERRORS[kind](); }
  take(value) { return describe(value); }
  raise(kind) { throw ERRORS[kind](); }
}

export class ErrorObject extends DurableObject {
  raise(kind) { throw ERRORS[kind](); }

  async store(kind) {
    try {
      await this.ctx.storage.put("error", ERRORS[kind]());
      return { ok: describe(await this.ctx.storage.get("error")) };
    } catch (error) {
      return { threw: describe(error) };
    }
  }
}

export async function report(env) {
  const out = {};
  for (const kind of Object.keys(ERRORS)) {
    out[kind] = {
      structuredClone: await attempt(() => structuredClone(ERRORS[kind]())),
      returned: await attempt(() => env.SELF.give(kind)),
      thrown: await attempt(() => env.SELF.raise(kind)),
      param: await env.SELF.take(ERRORS[kind]()).then((ok) => ({ ok }), (error) => ({ threw: describe(error) })),
      object: await attempt(() => env.OBJECT.get(env.OBJECT.idFromName("a")).raise(kind)),
      // A stored value that cannot be read back fails with workerd's
      // internal error, and with celld's own text (plan 1.63).
      stored: kind === "selfReference" ? null : await env.OBJECT.get(env.OBJECT.idFromName("a")).store(kind),
      peerEnhanced: await attempt(() => env.PEER_ENHANCED.raise(kind)),
      peerLegacy: await attempt(() => env.PEER_LEGACY.raise(kind)),
      // A function's stub cannot cross isolates on celld yet (plan Phase 3).
      peerReturned: kind === "function" ? null : await attempt(() => env.PEER_ENHANCED.give(kind)),
    };
  }
  return out;
}
