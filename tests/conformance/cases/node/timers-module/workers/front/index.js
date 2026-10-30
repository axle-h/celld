import { probe } from "../../probe.js";

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname === "/early") return env.EARLY.fetch(request);
    return Response.json(await probe());
  },
};
