import { report } from "../../send.js";

export default {
  fetch(request, env) {
    return report(env);
  },
};
