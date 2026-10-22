import { calls, Store } from "../../calls.js";

export class HasStore extends Store {}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === "/no") return env.NO.fetch(request);
    if (path === "/before") return env.BEFORE.fetch(request);
    return Response.json(await calls(env, { rpc: true }));
  },
};
