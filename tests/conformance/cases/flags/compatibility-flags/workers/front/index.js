import { report } from "../../report.js";

export default {
  fetch(request, env) {
    const binding = { "/old": env.OLD, "/mixed": env.MIXED }[new URL(request.url).pathname];
    return binding ? binding.fetch(request) : report();
  },
};
