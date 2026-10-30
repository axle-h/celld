// throw_on_unrecognized_import_assertion: workerd implements no import
// attribute, and with the flag refuses an import that has any; without it,
// it ignores them. A bundle keeps none (Wrangler's drops them, and so does
// celld's), so this Worker, on a date with the flag, loads with them; the
// modules that keep theirs are a Dynamic Worker's, which the Worker Loader
// takes as they are.
import { connect } from "cloudflare:sockets" with { type: "foo" };

const MAIN = `
import { value } from "./static.js" with { type: "data" };
const attempt = async (load) => {
  try {
    await load();
    return "loaded";
  } catch (error) {
    return \`\${error.name}: \${error.message}\`;
  }
};
export default {
  async fetch() {
    return Response.json({
      value,
      type: await attempt(() => import("./other.js", { with: { type: "foo" } })),
      json: await attempt(() => import("./other.js", { with: { type: "json" } })),
      empty: await attempt(() => import("./other.js", { with: {} })),
      builtin: await attempt(() => import("cloudflare:workers", { with: { mode: "x" } })),
      plain: await attempt(() => import("./other.js")),
      reported: Cloudflare.compatibilityFlags.throw_on_unrecognized_import_assertion ?? null,
    });
  },
};
`;
const DYNAMIC = `
const attempt = async (load) => {
  try {
    await load();
    return "loaded";
  } catch (error) {
    return \`\${error.name}: \${error.message}\`;
  }
};
export default {
  async fetch() {
    return Response.json({
      type: await attempt(() => import("./other.js", { with: { type: "foo" } })),
      json: await attempt(() => import("./other.js", { with: { type: "json" } })),
      empty: await attempt(() => import("./other.js", { with: {} })),
      builtin: await attempt(() => import("cloudflare:workers", { with: { mode: "x" } })),
      plain: await attempt(() => import("./other.js")),
    });
  },
};
`;
const MODULES = { "static.js": "export const value = 1;", "other.js": "export const other = 2;" };
const CASES = {
  on: { compatibilityDate: "2025-06-16" },
  before: { compatibilityDate: "2025-06-15" },
  enable: { compatibilityDate: "2025-01-01", compatibilityFlags: ["throw_on_unrecognized_import_assertion"] },
  disable: { compatibilityDate: "2026-09-04", compatibilityFlags: ["ignore_unrecognized_import_assertion"] },
};

async function load(env, name, code, main) {
  try {
    const worker = env.LOADER.get(`${name}-${main.length}`, () => ({
      ...code,
      mainModule: "main.js",
      modules: { "main.js": main, ...MODULES },
    }));
    const response = await worker.getEntrypoint().fetch("http://dynamic/");
    return await response.json();
  } catch (error) {
    return `${error.name}: ${error.message}`;
  }
}

export default {
  async fetch(request, env) {
    const out = {
      bundled: typeof connect,
      bundledDynamic: typeof (await import("cloudflare:workers", { with: { type: "foo" } })).DurableObject,
    };
    for (const [name, code] of Object.entries(CASES)) {
      out[name] = { static: await load(env, name, code, MAIN), dynamic: await load(env, name, code, DYNAMIC) };
    }
    return Response.json(out);
  },
};
