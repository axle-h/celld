import probe from "../../probe.js";

export { Echo } from "../../probe.js";

export default {
  fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    const binding = { "/before": env.BEFORE, "/no-cache-before": env.NO_CACHE_BEFORE, "/enable": env.ENABLE, "/enable-both": env.ENABLE_BOTH, "/disable": env.DISABLE, "/no-cache-disabled": env.NO_CACHE_DISABLED }[path];
    return binding ? binding.fetch(request) : probe.fetch(request, env, ctx);
  },
};
