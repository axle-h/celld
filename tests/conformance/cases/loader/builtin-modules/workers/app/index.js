// Which builtin modules a Dynamic Worker can import() under each date and
// flags: workerd's module registry has a `node:` module only with Node.js
// compatibility and the module's own flag, a bare name only with Node.js
// compatibility, and only the `cloudflare:` modules it implements, whatever
// the flags. `node:process` resolves without Node.js compatibility too.
//
// cloudflare:email is left out of the list: its implementation is a
// Miniflare extension, which workerd gives top-level Workers and not
// Dynamic ones. This Worker imports it to show a top-level Worker has it.
import "cloudflare:email";
import "cloudflare:workflows";

const BARE = [
  "_http_agent", "_http_client", "_http_common", "_http_incoming", "_http_outgoing",
  "_http_server", "_stream_duplex", "_stream_passthrough", "_stream_readable",
  "_stream_transform", "_stream_wrap", "_stream_writable", "_tls_common", "_tls_wrap",
  "assert", "assert/strict", "async_hooks", "buffer", "child_process", "cluster",
  "console", "constants", "crypto", "dgram", "diagnostics_channel", "dns",
  "dns/promises", "domain", "events", "fs", "fs/promises", "http", "http2", "https",
  "inspector", "inspector/promises", "module", "net", "os", "path", "path/posix",
  "path/win32", "perf_hooks", "process", "punycode", "querystring", "readline",
  "readline/promises", "repl", "sqlite", "stream", "stream/consumers",
  "stream/promises", "stream/web", "string_decoder", "sys", "test", "timers",
  "timers/promises", "tls", "trace_events", "tty", "url", "util", "util/types", "v8",
  "vm", "wasi", "worker_threads", "zlib",
];
const OTHER = [
  "node:nope", "node:test/reporters", "node:sea", "node:sqlite/x",
  "cloudflare:ai", "cloudflare:br", "cloudflare:durable-objects",
  "cloudflare:node", "cloudflare:pipelines", "cloudflare:sockets", "cloudflare:vectorize",
  "cloudflare:workers", "cloudflare:workflows", "cloudflare:nope", "cloudflare:test",
  "cloudflare-internal:env", "node-internal:crypto", "workerd:unsafe",
  "workerd:unsafe-eval", "workerd:rtti", "celld:python", "celld:internals",
];
const SPECS = [...BARE, ...BARE.map((name) => `node:${name}`), ...OTHER];

const child = (probeBuiltins) => `
const SPECS = ${JSON.stringify(SPECS)};
const PROBE_BUILTINS = ${probeBuiltins};
export default {
  async fetch() {
    const out = {};
    for (const spec of SPECS) {
      try {
        await import(spec);
        out[spec] = "ok";
      } catch (error) {
        out[spec] = String(error);
      }
    }
    const builtins = {};
    if (PROBE_BUILTINS) {
      for (const spec of SPECS) {
        try {
          builtins[spec] = process.getBuiltinModule(spec) === undefined ? "undefined" : "found";
        } catch (error) {
          builtins[spec] = String(error);
        }
      }
    }
    return Response.json({ imports: out, builtins });
  },
};`;

// With Node.js compatibility, each set also asks process.getBuiltinModule()
// for each specifier; without it there is no process on workerd.
const SETS = {
  none: { date: "2026-01-01", flags: [] },
  als: { date: "2026-01-01", flags: ["nodejs_als"] },
  compat: { date: "2026-01-01", flags: ["nodejs_compat"] },
  v2: { date: "2026-01-01", flags: ["nodejs_compat_v2"] },
  "v2-fs": { date: "2026-01-01", flags: ["nodejs_compat_v2", "enable_nodejs_fs_module"] },
  dated: { date: "2026-10-01", flags: [] },
  disabled: {
    date: "2026-10-01",
    flags: ["disable_nodejs_fs_module", "disable_nodejs_http_modules", "disable_nodejs_v8_module"],
  },
  "no-compat": { date: "2026-10-01", flags: ["no_nodejs_compat", "no_nodejs_compat_v2"] },
};

export default {
  async fetch(request, env) {
    const name = new URL(request.url).searchParams.get("set");
    if (!(name in SETS)) return new Response("unknown set", { status: 400 });
    const { date, flags } = SETS[name];
    try {
      const worker = env.LOADER.load({
        compatibilityDate: date,
        compatibilityFlags: flags,
        mainModule: "main.js",
        modules: { "main.js": child(!["none", "als", "no-compat"].includes(name)) },
      });
      const response = await worker.getEntrypoint().fetch("http://child/");
      return Response.json({ set: name, results: await response.json() });
    } catch (error) {
      return Response.json({ set: name, error: String(error) });
    }
  },
};
