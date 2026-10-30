const CASES = {
  refused: { compatibilityDate: "2026-02-01", compatibilityFlags: ["webcrypto_modern_algorithms"] },
  newestDate: { compatibilityDate: "2026-10-02" },
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
