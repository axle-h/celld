import { report } from "../../probe.js";

export { Errors, ErrorObject as ObjectFront } from "../../probe.js";

export default {
  async fetch(request, env) {
    const binding = { "/legacy": env.LEGACY, "/before": env.BEFORE, "/enable": env.ENABLE }[new URL(request.url).pathname];
    if (binding) return binding.fetch(request);
    return Response.json(await report(env));
  },
};
