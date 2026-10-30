import probe from "../../probe.js";

export default {
  fetch(request, env, ctx) {
    if (new URL(request.url).pathname.startsWith("/before")) return env.BEFORE.fetch(request);
    return probe.fetch(request, env, ctx);
  },
};
