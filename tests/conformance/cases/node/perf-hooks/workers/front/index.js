import { probe } from "../../probe.js";

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname === "/hooks") return env.HOOKS.fetch(request);
    return Response.json(await probe());
  },
};
