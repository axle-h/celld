import probe from "../../probe.js";

// The front Worker has no flag; it calls each other Worker's `/hold` too.
export default {
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    const binding = { "/on": env.ON, "/off": env.OFF }[path];
    if (binding) return binding.fetch(request);
    if (path === "/cross") {
      const results = {};
      for (const name of ["ON", "OFF"]) {
        const controller = new AbortController();
        const pending = env[name].fetch("http://x/hold", { signal: controller.signal })
          .then((response) => response.text(), (error) => `rejected: ${error.name}`);
        await scheduler.wait(100);
        controller.abort();
        const result = await pending;
        await scheduler.wait(900);
        results[name] = { result, entries: await (await env[name].fetch("http://x/held")).json() };
      }
      return Response.json(results);
    }
    return probe.fetch(request, env, ctx);
  },
};
