const settle = (promise) => promise.then(
  (result) => result === undefined
    ? "resolved"
    : { done: result.done, bytes: result.value?.byteLength ?? null },
  (error) => `${error.name}: ${error.message}`);

// A pending timer, not a promise nothing settles, which workerd would cancel
// as a hung Worker.
const within = (promise, ms = 300) => Promise.race([
  settle(promise),
  new Promise((resolve) => setTimeout(() => resolve("waiting"), ms)),
]);

const attempt = async (fn) => {
  try {
    return await fn();
  } catch (error) {
    return `threw ${error.name}: ${error.message}`;
  }
};

const fetched = async (env) => (await env.BACK.fetch("http://back/stalled")).body;

// Each kind of transform, made fresh.
const KINDS = {
  transform: () => new TransformStream(),
  identity: () => new IdentityTransformStream(),
};

// What a later request does with a stashed transform, each on one of its own.
const USES = {
  read: (t) => within(t.readable.getReader().read()),
  readByob: (t) => within(t.readable.getReader({ mode: "byob" }).read(new Uint8Array(8))),
  cancel: (t) => within(t.readable.cancel("stop")),
  write: (t) => within(t.writable.getWriter().write(new Uint8Array(4))),
  close: (t) => within(t.writable.getWriter().close()),
  abort: (t) => within(t.writable.abort("stop")),
};

const stash = {};

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === "/stash") {
      const out = {};
      for (const [kind, make] of Object.entries(KINDS)) {
        // A fetched body piped through, unread, and read once.
        stash[`${kind} piped`] = (await fetched(env)).pipeThrough(make());
        const piped = (await fetched(env)).pipeThrough(make());
        const reader = piped.getReader();
        out[`${kind} piped, read once`] = await within(reader.read());
        reader.releaseLock();
        stash[`${kind} piped, read once`] = piped;
        for (const use of Object.keys(USES)) stash[`${kind} ${use}`] = make();
      }
      return Response.json(out);
    }
    const out = {};
    for (const kind of Object.keys(KINDS)) {
      for (const name of [`${kind} piped`, `${kind} piped, read once`]) {
        out[name] = await attempt(async () => {
          const reader = stash[name].getReader();
          return { read: await within(reader.read()), closed: await within(reader.closed) };
        });
      }
      for (const [use, run] of Object.entries(USES))
        out[`${kind} ${use}`] = await attempt(() => run(stash[`${kind} ${use}`]));
    }
    return Response.json(out);
  },
};
