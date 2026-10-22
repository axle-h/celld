// Dynamic Workers that fail to start, and the error the Worker Loader gives
// for each: syntax errors, throws at module scope of every kind of value,
// a main module that is missing or not an ES module, imports that do not
// resolve or link, top-level await that rejects or never settles, and a
// handler lookup that throws. Each load runs twice, so a failure is
// reported the same way to the call after it.
const handler = `export default { fetch() { return new Response("loaded"); } };`;
const one = (src) => ({ mainModule: "main.js", modules: { "main.js": src } });
const modules = (main, others) => ({ mainModule: "main.js", modules: { "main.js": main, ...others } });

const children = {
  ok: one(handler),
  // Syntax errors: the location is where V8's parser stopped, and its
  // column is left out when it is 0.
  syntax: one(`export default {\n  fetch() { return new Response("x") \n`),
  "syntax-token": one(`${handler}\nlet = = 1;\n`),
  "syntax-in-dep": modules(`import "./dep.js";\n${handler}`, { "dep.js": `let x = ;\n` }),
  // Throws at module scope: an Error reports the frames where it was
  // constructed; any other value has no location.
  "throw-error": one(`${handler}\nthrow new Error("boom");\n`),
  "throw-type-error": one(`${handler}\nthrow new TypeError("bad type");\n`),
  "throw-eval-error": one(`${handler}\nthrow new EvalError("evil");\n`),
  "throw-aggregate": one(`${handler}\nthrow new AggregateError([new Error("a")], "agg");\n`),
  "throw-dom-exception": one(`${handler}\nthrow new DOMException("dom", "SyntaxError");\n`),
  "throw-empty-message": one(`${handler}\nthrow new Error();\n`),
  "throw-multiline": one(`${handler}\nthrow new Error("line one\\nline two");\n`),
  "throw-custom-name": one(`${handler}\nconst e = new Error("named"); e.name = "MyError"; throw e;\n`),
  "throw-subclass": one(`${handler}\nclass AppError extends Error { constructor(m) { super(m); this.name = "AppError"; } }\nthrow new AppError("sub");\n`),
  "throw-no-stack": one(`${handler}\nconst e = new Error("nostack"); e.stack = undefined; throw e;\n`),
  "throw-nested": one(`${handler}\nfunction inner() { throw new RangeError("deep"); }\nfunction outer() { inner(); }\nouter();\n`),
  "throw-deep": one(`${handler}\nfunction down(n) { if (n === 0) throw new Error("bottom"); down(n - 1); }\ndown(12);\n`),
  "throw-method": one(`${handler}\nclass Box { open() { throw new Error("lid"); } }\nnew Box().open();\n`),
  "throw-arrow": one(`${handler}\nconst go = () => { throw new Error("arrow"); };\n[1].forEach(go);\n`),
  "throw-in-dep": modules(`import "./dep.js";\n${handler}`, { "dep.js": `\nthrow new Error("from dep");\n` }),
  "throw-cross-module": modules(`import { fail } from "./lib/util.js";\nfail();\n${handler}`, {
    "lib/util.js": `export function fail() {\n  throw new Error("in util");\n}\n`,
  }),
  "throw-string": one(`${handler}\nthrow "a string";\n`),
  "throw-error-string": one(`${handler}\nthrow "Error: looks typed";\n`),
  "throw-number": one(`${handler}\nthrow 42;\n`),
  "throw-null": one(`${handler}\nthrow null;\n`),
  "throw-undefined": one(`${handler}\nthrow undefined;\n`),
  "throw-symbol": one(`${handler}\nthrow Symbol("sym");\n`),
  "throw-object": one(`${handler}\nthrow { code: 1 };\n`),
  "throw-object-tostring": one(`${handler}\nthrow { toString() { return "custom"; } };\n`),
  "throw-captured-object": one(`${handler}\nconst o = { message: "plain" };\nError.captureStackTrace(o);\nthrow o;\n`),
  "throw-proxy": one(`${handler}\nconst spin = () => { while (true) {} };\nthrow new Proxy({}, { getPrototypeOf: spin });\n`),
  // A DOMException is described by the name and message it was made with.
  "dom-renamed": one(`${handler}\nconst e = new DOMException("dom", "SyntaxError");\nReflect.set(e, "name", "Other");\nReflect.set(e, "message", "changed");\nthrow e;\n`),
  "dom-getter": one(`${handler}\nconst e = new DOMException("dom", "SyntaxError");\nObject.defineProperty(e, "name", { get() { return "FromGetter"; } });\nthrow e;\n`),
  "dom-prototype-object": one(`${handler}\nthrow Object.create(DOMException.prototype);\n`),
  // Throws from the runtime's own APIs: the frames are the Worker's only.
  "api-structured-clone": one(`${handler}\nstructuredClone(() => {});\n`),
  "api-abort": one(`${handler}\nAbortSignal.abort().throwIfAborted();\n`),
  // The main module.
  "missing-main": { mainModule: "nope.js", modules: { "main.js": handler } },
  "main-json": { mainModule: "data.json", modules: { "data.json": { json: { a: 1 } } } },
  "main-text": { mainModule: "t.txt", modules: { "t.txt": { text: "hi" } } },
  "main-commonjs": { mainModule: "main.cjs", modules: { "main.cjs": { cjs: "module.exports = {};" } } },
  "main-wasm": { mainModule: "m.wasm", modules: { "m.wasm": { wasm: new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]) } } },
  // Imports: a module that is not there is named by its path from the
  // root; a name a module does not export is V8's link error.
  "import-missing-file": one(`import "./missing.js";\n${handler}`),
  "import-missing-relative": modules(`import "./lib/a.js";\n${handler}`, { "lib/a.js": `import "../gone.js";\n` }),
  "import-bare": one(`import "left-pad";\n${handler}`),
  "import-bare-nested": modules(`import "./lib/a.js";\n${handler}`, { "lib/a.js": `import "left-pad";\n` }),
  "import-missing-builtin": one(`import "cloudflare:nope";\n${handler}`),
  "import-up-past-root": one(`import "../x.js";\n${handler}`),
  "import-up-past-root-nested": modules(`import "./lib/a.js";\n${handler}`, { "lib/a.js": `import "../../up.js";\n` }),
  "import-root-relative": modules(`import "./lib/a.js";\n${handler}`, { "lib/a.js": `import "/root.js";\n` }),
  "import-root-relative-found": modules(`import "./lib/a.js";\n${handler}`, { "lib/a.js": `import "/util.js";\n`, "util.js": `` }),
  "import-dynamic-missing": one(`${handler}\nawait import("./nope.js");\n`),
  "unimported-sibling-syntax": modules(handler, { "lib/bad.js": `export default {` }),
  "import-missing-export": modules(`import { nope } from "./dep.js";\n${handler}`, { "dep.js": `export const yes = 1;` }),
  // Top-level await.
  "tla-reject": one(`${handler}\nawait Promise.reject(new Error("tla"));\n`),
  "tla-reject-string": one(`${handler}\nawait Promise.reject("tla string");\n`),
  "tla-throw-after-await": one(`${handler}\nawait null;\nthrow new Error("after await");\n`),
  "tla-never": one(`${handler}\nawait new Promise(() => {});\n`),
  // The exports.
  "throw-handler-getter": one(`export default { get fetch() { throw new Error("getter"); } };\n`),
  "export-primitive": one(`${handler}\nexport const n = 1;\n`),
};

function describe(error) {
  return {
    type: typeof error,
    name: error?.name,
    message: error?.message,
    stackHead: typeof error?.stack === "string" ? error.stack.startsWith(`${error.name}: ${error.message}`) : null,
    ctor: error?.constructor?.name,
    keys: error && typeof error === "object" ? Object.keys(error) : null,
    string: String(error),
  };
}

export default {
  async fetch(request, env) {
    const params = new URL(request.url).searchParams;
    const name = params.get("child");
    const via = params.get("via") ?? "load";
    if (!(name in children)) return new Response("unknown child", { status: 400 });
    const code = () => ({ compatibilityDate: "2026-01-01", ...children[name] });
    const results = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      let stage = "load";
      try {
        const worker = via === "get" ? env.LOADER.get(name, code) : env.LOADER.load(code());
        stage = "fetch";
        const response = await worker.getEntrypoint().fetch("http://child/");
        results.push({ status: response.status, body: await response.text() });
      } catch (error) {
        results.push({ stage, ...describe(error) });
      }
    }
    return Response.json({ child: name, via, results });
  },
};
