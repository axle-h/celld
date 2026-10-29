// A Dynamic Worker whose load fails for good keeps its loader entry until its
// stub is collected, but no longer counts as a loaded Worker: 255 failed
// loads still referenced leave room for a Worker that loads. The failures
// a script keeps referenced are bounded on their own (256).
const failing = `throw new Error("never starts"); export default {};`;
const working = `export default { fetch() { return new Response("loaded"); } };`;

const held = [];

function load(env, source) {
  return env.LOADER.load({
    compatibilityDate: "2026-01-01",
    mainModule: "main.js",
    modules: { "main.js": source },
  });
}

async function call(worker) {
  try {
    const response = await worker.getEntrypoint().fetch("http://child/");
    return await response.text();
  } catch (error) {
    return error.message;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/fail") {
      const count = Number(url.searchParams.get("count"));
      const errors = new Set();
      for (let i = 0; i < count; i++) {
        const worker = load(env, failing);
        held.push(worker);
        errors.add(await call(worker));
      }
      return Response.json({ held: held.length, errors: [...errors] });
    }
    if (url.pathname === "/load") {
      try {
        const worker = load(env, url.searchParams.get("code") === "failing" ? failing : working);
        held.push(worker);
        return Response.json({ held: held.length, body: await call(worker) });
      } catch (error) {
        return Response.json({ error: error.message });
      }
    }
    return new Response("not found", { status: 404 });
  },
};
