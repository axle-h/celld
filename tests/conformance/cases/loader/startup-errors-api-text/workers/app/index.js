// Runtime APIs that throw at a Dynamic Worker's module scope. The report's
// location is the Worker's own frame on both runtimes, and the messages are
// the APIs' own (plan 1.40; builtins/api-error-text has many more).
const handler = `export default { fetch() { return new Response("loaded"); } };`;

const children = {
  url: `new URL("bad");`,
  atob: `atob("@@");`,
  headers: `new Headers([["a"]]);`,
  "text-decoder": `new TextDecoder("bogus");`,
};

export default {
  async fetch(request, env) {
    const name = new URL(request.url).searchParams.get("child");
    if (!(name in children)) return new Response("unknown child", { status: 400 });
    try {
      const worker = env.LOADER.load({
        compatibilityDate: "2026-01-01",
        mainModule: "main.js",
        modules: { "main.js": `${handler}\n${children[name]}\n` },
      });
      const response = await worker.getEntrypoint().fetch("http://child/");
      return Response.json({ child: name, status: response.status, body: await response.text() });
    } catch (error) {
      return Response.json({ child: name, error: error.name, message: error.message });
    }
  },
};
