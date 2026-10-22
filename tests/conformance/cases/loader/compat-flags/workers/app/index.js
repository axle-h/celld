const CASES = {
  accepted: { compatibilityDate: "2026-02-01", compatibilityFlags: ["disallow_importable_env", "allow_irrevocable_stub_storage"] },
  unknown: { compatibilityDate: "2026-02-01", compatibilityFlags: ["no_such_flag"] },
  twice: { compatibilityDate: "2026-02-01", compatibilityFlags: ["nodejs_als", "nodejs_als"] },
  contradictory: { compatibilityDate: "2026-02-01", compatibilityFlags: ["rpc_params_dup_stubs", "rpc_params_transfer_stubs"] },
  invalidDate: { compatibilityDate: "2026-02" },
  notStrings: { compatibilityDate: "2026-02-01", compatibilityFlags: [1] },
  notArray: { compatibilityDate: "2026-02-01", compatibilityFlags: "nodejs_als" },
  dateNumber: { compatibilityDate: 20260201 },
  noDate: {},
  shortDate: { compatibilityDate: "2026-2-1" },
  shortDay: { compatibilityDate: "2026-02-1" },
  experimental: { compatibilityDate: "2026-02-01", compatibilityFlags: ["experimental"] },
  extraHandlers: { compatibilityDate: "2026-02-01", compatibilityFlags: ["service_binding_extra_handlers"] },
  symbolFlag: { compatibilityDate: "2026-02-01", compatibilityFlags: [Symbol("flag")] },
  symbolDate: { compatibilityDate: Symbol("date") },
  hole: { compatibilityDate: "2026-02-01", compatibilityFlags: [, "nodejs_als"] },
  nullFlags: { compatibilityDate: "2026-02-01", compatibilityFlags: null },
};

export default {
  async fetch(request, env) {
    const out = {};
    for (const [name, code] of Object.entries(CASES)) {
      try {
        const worker = env.LOADER.get(`compat-${name}`, () => ({
          ...code,
          mainModule: "main.js",
          modules: { "main.js": "export default { fetch() { return new Response('loaded'); } };" },
        }));
        const response = await worker.getEntrypoint().fetch("http://dynamic/");
        out[name] = await response.text();
      } catch (error) {
        out[name] = `${error.name}: ${error.message}`;
      }
    }
    return Response.json(out);
  },
};
