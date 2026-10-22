import { Base, report } from "../../object.js";

export class FrontObject extends Base {}

export default {
  fetch(request, env) {
    const binding = { "/before": env.BEFORE, "/enable": env.ENABLE, "/disable": env.DISABLE }[
      new URL(request.url).pathname
    ];
    if (binding) return binding.fetch(request);
    return report(env);
  },
};
