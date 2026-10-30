import probe from "../../probe.js";

export default {
  fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    const binding = { "/before": env.BEFORE, "/transform-only": env.TRANSFORM_ONLY, "/original-transform": env.ORIGINAL_TRANSFORM, "/no-encoder": env.NO_ENCODER, "/enable": env.ENABLE }[path];
    return binding ? binding.fetch(request) : probe.fetch(request, env, ctx);
  },
};
