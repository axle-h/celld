import { calls, Store } from "../../calls.js";

export class NoStore extends Store {}

export default {
  async fetch(request, env) {
    return Response.json(await calls(env, { rpc: true }));
  },
};
