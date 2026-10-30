// Which builtin modules a Dynamic Worker can import statically. workerd has
// a `node:` module only under the flags that provide it, a bare name only
// with Node.js compatibility, and no `cloudflare:` or `workerd:` module it
// does not implement, so importing one fails the Worker's start. Every form
// of import links a builtin it has: side-effect, minified, re-exports.
// (loader/builtin-modules covers every name through import().)
const handler = `export default { fetch() { return new Response("loaded"); } };`;
const answer = (expr) => `export default { fetch() { return new Response(String(${expr})); } };`;
const compat = ["nodejs_compat"];

const children = {
  "node-default": { flags: [], src: `import fs from "node:fs";\n${handler}` },
  "node-named": { flags: [], src: `import { Buffer } from "node:buffer";\n${handler}` },
  "node-bare": { flags: [], src: `import path from "path";\n${handler}` },
  "cloudflare-named": { flags: [], src: `import { nope } from "cloudflare:nope";\n${handler}` },
  "node-side-effect": { flags: compat, src: `import "node:buffer";\n${handler}` },
  "node-side-effect-minified": { flags: compat, src: `import"node:buffer";import"node:events";\n${handler}` },
  "node-side-effect-missing": { flags: [], src: `import "node:buffer";\n${handler}` },
  // Re-exports live in a sibling: a main module's exports are entrypoints.
  "node-export-star": {
    flags: compat,
    lib: `export * from "node:path";\nexport * as events from "node:events";`,
    src: `import * as lib from "./lib.js";\n${answer("typeof lib.join + typeof lib.events.once")}`,
  },
  "node-export-named": {
    flags: compat,
    lib: `export { join, sep as separator } from "node:path";\nexport{Buffer}from"node:buffer";`,
    src: `import * as lib from "./lib.js";\n${answer("lib.separator + typeof lib.Buffer")}`,
  },
  "node-export-missing": {
    flags: [],
    lib: `export { join } from "node:path";`,
    src: `import "./lib.js";\n${handler}`,
  },
  "node-export-star-missing": {
    flags: [],
    lib: `export * from "node:path";`,
    src: `import "./lib.js";\n${handler}`,
  },
  "node-names-across-modules": {
    flags: compat,
    lib: `import { sep } from "path";\nexport const separator = sep;`,
    src: `import { join } from "node:path";\nimport { separator } from "./lib.js";\n${answer("join(separator, typeof join)")}`,
  },
  "node-import-commented": {
    flags: compat,
    src: `import /* side effects */ "node:buffer";\nimport { /* a */ join } /* b */ from "node:path";\n${answer("join('a')")}`,
  },
  "node-gated": { flags: compat, src: `import v8 from "node:v8";\n${handler}` },
  "node-bare-gated": { flags: compat, src: `import "v8";\n${handler}` },
  "node-gated-flag": {
    flags: [...compat, "enable_nodejs_v8_module"],
    src: `import v8 from "node:v8";\n${handler}`,
  },
  "node-fs-disabled": {
    flags: [...compat, "disable_nodejs_fs_module"],
    src: `import { readFileSync } from "fs";\n${handler}`,
  },
  "node-fs-promises-v2": {
    flags: ["nodejs_compat_v2"],
    src: `import { readFile } from "node:fs/promises";\n${answer("typeof readFile")}`,
  },
  "node-bare-compat": {
    flags: compat,
    src: `import { join } from "path";\nimport p from "node:path";\n${answer(`join("a", "b") + (p.join === join)`)}`,
  },
  "node-sys": { flags: compat, src: `import { format } from "sys";\n${answer(`format("%d", 1)`)}` },
  "node-test-bare": { flags: compat, src: `import "test";\n${handler}` },
  "node-als": {
    flags: ["nodejs_als"],
    src: `import { AsyncLocalStorage } from "node:async_hooks";\n${answer("typeof AsyncLocalStorage")}`,
  },
  "node-als-bare": { flags: ["nodejs_als"], src: `import "async_hooks";\n${handler}` },
  "node-process": { flags: [], src: `import process from "node:process";\n${handler}` },
  "node-dated": {
    date: "2026-10-01",
    flags: [],
    src: `import { inspect } from "util";\nimport "node:v8";\n${answer(`inspect(1)`)}`,
  },
  "cloudflare-known": {
    flags: [],
    src: `import { connect } from "cloudflare:sockets";\nimport "cloudflare:pipelines";\nimport * as ai from "cloudflare:ai";\n${answer("typeof connect")}`,
  },
  "cloudflare-side-effect": { flags: [], src: `import "cloudflare:nope";\n${handler}` },
  "cloudflare-export": { flags: [], src: `export * from "cloudflare:nope";\n${handler}` },
  "workerd-unsafe": { flags: [], src: `import "workerd:unsafe";\n${handler}` },
};

export default {
  async fetch(request, env) {
    const name = new URL(request.url).searchParams.get("child");
    if (!(name in children)) return new Response("unknown child", { status: 400 });
    const { date = "2026-01-01", flags, src, lib } = children[name];
    try {
      const worker = env.LOADER.load({
        compatibilityDate: date,
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
