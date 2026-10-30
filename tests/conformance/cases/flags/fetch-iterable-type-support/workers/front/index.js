import probe from "../../probe.js";

export default {
  fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    const binding = { "/before": env.BEFORE, "/enable": env.ENABLE, "/enable-adjusted": env.ENABLE_ADJUSTED, "/no-adjustment": env.NO_ADJUSTMENT, "/adjustment-only": env.ADJUSTMENT_ONLY, "/disable": env.DISABLE }[path];
    return binding ? binding.fetch(request) : probe.fetch(request, env, ctx);
  },
};
