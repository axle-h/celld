import probe from "../../probe.js";

export default {
  fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    const binding = { "/early": env.EARLY, "/disable": env.DISABLE }[path];
    return binding ? binding.fetch(request) : probe.fetch(request, env, ctx);
  },
};
