import probe from "../../probe.js";

export { Thing as ObjectFront } from "../../probe.js";

export default {
  fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    const binding = { "/before": env.BEFORE, "/enable": env.ENABLE, "/disable": env.DISABLE }[path];
    return binding ? binding.fetch(request) : probe.fetch(request, env, ctx);
  },
};
