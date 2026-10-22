import { report } from "../../send.js";

export default {
  fetch(request, env) {
    const binding = { "/before": env.BEFORE, "/v8": env.V8, "/json": env.JSON }[
      new URL(request.url).pathname
    ];
    if (binding) return binding.fetch(request);
    return report(env);
  },
};
