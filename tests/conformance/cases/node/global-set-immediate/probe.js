// The global setImmediate and clearImmediate, which workerd's global scope
// has under nodejs_compat_v2 (api/global-scope.h): API methods that answer
// with an Immediate, whatever enable_nodejs_global_timers makes of
// setTimeout. Each Worker runs this under its own date and flags.
const t = (f) => {
  try {
    const value = f();
    return value === undefined ? "undefined" : value;
  } catch (e) {
    return `threw ${e.name}: ${e.message}`;
  }
};

export async function probe() {
  const out = {
    flags: Object.fromEntries(["nodejs_compat", "nodejs_compat_v2", "enable_nodejs_global_timers"]
      .map((k) => [k, Cloudflare.compatibilityFlags[k] ?? null])),
    setImmediate: typeof globalThis.setImmediate,
    clearImmediate: typeof globalThis.clearImmediate,
  };
  if (typeof setImmediate !== "function") return out;
  const immediate = setImmediate(() => {});
  clearImmediate(immediate);
  out.returns = [typeof immediate, Object.prototype.toString.call(immediate),
    immediate.hasRef(), immediate.constructor.name];
  out.functions = [setImmediate.name, setImmediate.length, clearImmediate.name,
    clearImmediate.length];
  out.refused = [t(() => setImmediate()), t(() => setImmediate(5)), t(() => clearImmediate()),
    t(() => clearImmediate(5)), t(() => clearImmediate(setTimeout(() => {}, 1)))];
  out.accepted = [t(() => clearImmediate(undefined)), t(() => clearImmediate(null))];
  out.fires = await new Promise((resolve) => setImmediate((a, b) => resolve([a, b]), "x", "y"));
  const ran = (cancel) => new Promise((resolve) => {
    let fired = false;
    cancel(setImmediate(() => { fired = true; }));
    setTimeout(() => resolve(fired), 20);
  });
  out.cleared = [await ran((i) => clearImmediate(i)), await ran((i) => i[Symbol.dispose]())];
  out.order = await new Promise((resolve) => {
    const seen = [];
    setTimeout(() => seen.push("timeout"), 5);
    setImmediate(() => seen.push("immediate"));
    Promise.resolve().then(() => seen.push("microtask"));
    setTimeout(() => resolve(seen), 20);
  });
  return out;
}
