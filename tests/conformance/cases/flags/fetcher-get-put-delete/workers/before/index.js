import { calls } from "../../calls.js";

export default {
  async fetch(request, env) {
    return Response.json(await calls(env, { rpc: false }));
  },
};
