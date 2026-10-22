// Dynamic Workers whose loads never finish: module scope that loops, and a
// default export whose `fetch` getter loops when the runtime reads it. Each
// load must fail with Cloudflare's startup error after the startup CPU limit,
// and the parent must keep serving.
const handler = `export default { fetch() { return new Response("loaded"); } };`;

const children = {
  ok: handler,
  "module-scope": `while (true) {}\n${handler}`,
  "handler-getter": `export default { get fetch() { while (true) {} } };`,
};

export default {
  async fetch(request, env) {
    const name = new URL(request.url).searchParams.get("child");
    if (!(name in children)) return new Response("unknown child", { status: 400 });
    try {
      const worker = env.LOADER.load({
        compatibilityDate: "2026-01-01",
        mainModule: "main.js",
        modules: { "main.js": children[name] },
      });
      const response = await worker.getEntrypoint().fetch("http://child/");
      return Response.json({ child: name, status: response.status, body: await response.text() });
    } catch (error) {
      return Response.json({ child: name, error: error.name, message: error.message });
    }
  },
};
