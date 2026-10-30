// The global scope's unhandledrejection event. A rejection is recorded
// whether or not a listener exists when it happens, so a listener added in
// the same tick still hears it. The runtime's own bookkeeping, which runs
// inside V8's promise rejection hook, calls nothing a script replaced on
// Map.prototype, Array.prototype or Object.prototype.
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

export default {
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/late") {
      const heard = [];
      Promise.reject(new Error("late"));
      const listener = (event) => {
        heard.push(event.reason.message);
        event.preventDefault();
      };
      addEventListener("unhandledrejection", listener);
      await tick();
      removeEventListener("unhandledrejection", listener);
      return Response.json(heard);
    }
    // /hijack. The timer is set before the spies are, so they see only
    // what the rejections run.
    const timer = tick();
    const calls = [];
    const listener = (event) => event.preventDefault();
    addEventListener("unhandledrejection", listener);
    addEventListener("rejectionhandled", listener);
    const saved = {
      get: Map.prototype.get, set: Map.prototype.set, has: Map.prototype.has,
      del: Map.prototype.delete, iter: Array.prototype[Symbol.iterator],
      push: Array.prototype.push, slice: Array.prototype.slice,
    };
    let recording = true;
    // Neither the spy nor the getter uses what it spies on.
    const spy = (name, original) => function () {
      if (recording) calls[calls.length] = name;
      return Reflect.apply(original, this, arguments);
    };
    Map.prototype.get = spy("Map get", saved.get);
    Map.prototype.set = spy("Map set", saved.set);
    Map.prototype.has = spy("Map has", saved.has);
    Map.prototype.delete = spy("Map delete", saved.del);
    Array.prototype[Symbol.iterator] = spy("Array iterator", saved.iter);
    Array.prototype.push = spy("Array push", saved.push);
    Array.prototype.slice = spy("Array slice", saved.slice);
    Object.defineProperty(Object.prototype, "bubbles", {
      get() { if (recording) calls[calls.length] = "Object bubbles"; return undefined; },
      configurable: true,
    });
    try {
      const rejected = Promise.reject(new Error("one"));
      new Promise((_, reject) => reject(new Error("two"))).then(() => {});
      await new Promise((resolve) => queueMicrotask(resolve));
      rejected.catch(() => {});
      await timer;
    } finally {
      recording = false;
      Map.prototype.get = saved.get;
      Map.prototype.set = saved.set;
      Map.prototype.has = saved.has;
      Map.prototype.delete = saved.del;
      Array.prototype[Symbol.iterator] = saved.iter;
      Array.prototype.push = saved.push;
      Array.prototype.slice = saved.slice;
      delete Object.prototype.bubbles;
      removeEventListener("unhandledrejection", listener);
      removeEventListener("rejectionhandled", listener);
    }
    return Response.json(calls);
  },
};
