// Which builtin modules a Dynamic Worker can import. workerd has a `node:`
// module only under the flags that provide it, and no `cloudflare:` module
// it does not implement, so importing one fails the Worker's start; a
// side-effect import of a builtin it has links.
const handler = `export default { fetch() { return new Response("loaded"); } };`;

const children = {
  "node-default": { flags: [], src: `import fs from "node:fs";\n${handler}` },
  "node-named": { flags: [], src: `import { Buffer } from "node:buffer";\n${handler}` },
  "node-bare": { flags: [], src: `import path from "path";\n${handler}` },
  "cloudflare-named": { flags: [], src: `import { nope } from "cloudflare:nope";\n${handler}` },
  "node-side-effect": { flags: ["nodejs_compat"], src: `import "node:buffer";\n${handler}` },
};

export default {
  async fetch(request, env) {
    const name = new URL(request.url).searchParams.get("child");
    if (!(name in children)) return new Response("unknown child", { status: 400 });
    const { flags, src } = children[name];
    try {
      const worker = env.LOADER.load({
        compatibilityDate: "2026-01-01",
        compatibilityFlags: flags,
        mainModule: "main.js",
        modules: { "main.js": src },
      });
      const response = await worker.getEntrypoint().fetch("http://child/");
      return Response.json({ child: name, status: response.status, body: await response.text() });
    } catch (error) {
      return Response.json({ child: name, error: error.name, message: error.message });
    }
  },
};
