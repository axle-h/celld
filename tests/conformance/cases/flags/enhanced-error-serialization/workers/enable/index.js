import { report } from "../../probe.js";

export { Errors, ErrorObject as ObjectEnable } from "../../probe.js";

export default {
  async fetch(request, env) {
    return Response.json(await report(env));
  },
};
