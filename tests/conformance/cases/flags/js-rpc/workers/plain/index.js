import { call, Counter } from "../../object.js";

export class PlainCounter extends Counter {}

export default {
  async fetch(request, env) {
    return Response.json(await call(env, "plain"));
  },
};
