import probe from "../../probe.js";

export { Things, Thing as ObjectFront } from "../../probe.js";

export default {
  fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    const binding = { "/disable": env.DISABLE }[path];
    return binding ? binding.fetch(request) : probe.fetch(request, env, ctx);
  },
};
