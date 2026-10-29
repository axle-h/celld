// Dynamic Workers whose loads retain about 500 MB, four times the isolate's
// 128 MiB heap limit. Each load must fail with Cloudflare's startup error,
// and the parent and the node must keep serving: the last step loads a Worker
// again. Before celld enforced the limit during the load, each one loaded.
import { DurableObject } from "cloudflare:workers";

const handler = `export default { fetch() { return new Response("loaded"); } };`;

// Two thousand env keys that alias one array: the env crosses as about
// 160 KiB of structured clone, and copying it into process.env stringifies
// the array once for every key, about 500 MB in all.
const shared = Array.from({ length: 30000 }, (_, index) => index * 1000);
const aliased = Object.fromEntries(Array.from({ length: 2000 }, (_, index) => [`K${index}`, shared]));

const children = {
  ok: { main: handler },
  arrays: { main: `const keep = []; for (let i = 0; i < 8e6; i++) keep.push([i, 1, 2]);\n${handler}` },
  // toUpperCase() copies each string flat: a repeat() result shares its parts.
  strings: { main: `const keep = []; for (let i = 0; i < 1.2e5; i++) keep.push(("x".repeat(4096) + i).toUpperCase());\n${handler}` },
  // One allocation larger than the limit: a 480 MB FixedDoubleArray, which
  // V8 builds while the array it converts is still live, and a 400 MB
  // two-byte string. Each is past the limit by a wide margin and well under
  // V8's largest object, so a V8 upgrade does not turn it into a RangeError.
  // Each must finish before the termination lands, and the node must not
  // abort.
  "one-array": { main: `globalThis.keep = new Array(6e7).fill(1.5);\n${handler}` },
  "one-string": { main: `globalThis.keep = "\\u1234".repeat(2e8).toLowerCase();\n${handler}` },
  "process-env": {
    main: handler,
    env: aliased,
    compatibilityFlags: ["nodejs_compat"],
  },
};

function code(name) {
  const child = children[name];
  return {
    compatibilityDate: "2026-01-01",
    compatibilityFlags: child.compatibilityFlags ?? [],
    mainModule: "main.js",
    modules: { "main.js": `${child.main}${facetClass}` },
    env: child.env ?? {},
  };
}

// A root whose facet's class is a Dynamic Worker's: a load past the limit
// fails the facet call, and the root's next facet, of a Worker that loads,
// works.
export class Root extends DurableObject {
  async call(name) {
    const worker = this.env.LOADER.load(code(name));
    const facet = this.ctx.facets.get(name, () => ({ class: worker.getDurableObjectClass("Facet") }));
    const response = await facet.fetch("http://facet/");
    return { status: response.status, body: await response.text() };
  }
}

const facetClass = `
import { DurableObject } from "cloudflare:workers";
export class Facet extends DurableObject {
  async fetch() {
    const count = (await this.ctx.storage.get("count")) ?? 0;
    await this.ctx.storage.put("count", count + 1);
    return new Response("facet " + count);
  }
}`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const name = url.searchParams.get("child");
    if (!(name in children)) return new Response("unknown child", { status: 400 });
    if (url.pathname === "/facet") {
      try {
        return Response.json({ child: name, ...(await env.ROOT.getByName("root").call(name)) });
      } catch (error) {
        return Response.json({ child: name, error: error.name, message: error.message });
      }
    }
    try {
      const worker = url.pathname === "/get"
        ? env.LOADER.get(name, () => code(name))
        : env.LOADER.load(code(name));
      const response = await worker.getEntrypoint().fetch("http://child/");
      return Response.json({ child: name, status: response.status, body: await response.text() });
    } catch (error) {
      return Response.json({ child: name, error: error.name, message: error.message });
    }
  },
};
