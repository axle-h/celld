import { probe } from "../../probe.js";
export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname.slice(1);
    if (path) return env[path.toUpperCase()].fetch(request);
    return Response.json(await probe());
  },
};
