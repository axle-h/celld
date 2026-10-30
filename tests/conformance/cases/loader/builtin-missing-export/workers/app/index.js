// A static import of a name a builtin module does not export fails the
// Worker's start on workerd, as V8 links modules. celld's stub of a builtin
// exports every name the Worker imports, so the Worker starts and the name
// reads as undefined, or as a stub that throws on use.
const handler = `export default { fetch() { return new Response("loaded"); } };`;
const compat = ["nodejs_compat"];

const children = {
  "node-implemented": { flags: compat, src: `import { nope } from "node:path";\n${handler}` },
  "node-stubbed": { flags: compat, src: `import { nope } from "node:http";\n${handler}` },
  "node-default": { flags: compat, src: `import nope from "node:test";\n${handler}` },
  "cloudflare-stubbed": { flags: [], src: `import { nope } from "cloudflare:pipelines";\n${handler}` },
  "cloudflare-sockets": { flags: [], src: `import { nope } from "cloudflare:sockets";\n${handler}` },
  "re-export": {
    flags: compat,
    lib: `export { nope } from "node:buffer";`,
    src: `import "./lib.js";\n${handler}`,
  },
};

export default {
  async fetch(request, env) {
    const name = new URL(request.url).searchParams.get("child");
    if (!(name in children)) return new Response("unknown child", { status: 400 });
    const { flags, src, lib } = children[name];
    try {
      const worker = env.LOADER.load({
        compatibilityDate: "2026-01-01",
        compatibilityFlags: flags,
        mainModule: "main.js",
        modules: lib === undefined ? { "main.js": src } : { "main.js": src, "lib.js": lib },
      });
      const response = await worker.getEntrypoint().fetch("http://child/");
      return Response.json({ child: name, status: response.status, body: await response.text() });
    } catch (error) {
      return Response.json({ child: name, error: error.name, message: error.message });
    }
  },
};
