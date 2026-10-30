// A Node.js module's refusal at a Dynamic Worker's module scope. workerd's
// node: modules are JavaScript, so its startup error lists their frames
// (`node-internal:…`) above the caller's; celld's are its own and listed by
// no frame (plan 1.67).
const handler = `export default { fetch() { return new Response("loaded"); } };`;

const children = {
  "node-random-bytes": `import { randomBytes } from "node:crypto";\nrandomBytes(1);`,
  "node-timers-promises": `import { setTimeout } from "node:timers/promises";\nawait setTimeout(0);`,
};

export default {
  async fetch(request, env) {
    const name = new URL(request.url).searchParams.get("child");
    if (!(name in children)) return new Response("unknown child", { status: 400 });
    try {
      const worker = env.LOADER.load({
        compatibilityDate: "2026-01-01",
        compatibilityFlags: ["nodejs_compat"],
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
