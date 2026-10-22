import { dial } from "../../shared.js";

export default {
  fetch(request, env) {
    if (new URL(request.url).pathname.startsWith("/manual/")) return env.MANUAL.fetch(request);
    return dial(request);
  },
};
