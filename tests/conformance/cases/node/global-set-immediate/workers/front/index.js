import { probe } from "../../probe.js";

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === "/nonode") return env.NONODE.fetch(request);
    if (path === "/v1") return env.V1.fetch(request);
    return Response.json(await probe());
  },
};
