import probe from "../../probe.js";

export { Flow } from "../../probe.js";

export default {
  fetch(request, env, ctx) {
    if (new URL(request.url).pathname === "/legacy") return env.LEGACY.fetch(request);
    return probe.fetch(request, env, ctx);
  },
};
