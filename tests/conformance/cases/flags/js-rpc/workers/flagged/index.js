import { call, Counter } from "../../object.js";

export class FlaggedCounter extends Counter {}

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname === "/plain") return env.PLAIN.fetch(request);
    return Response.json(await call(env, "flagged"));
  },
};
