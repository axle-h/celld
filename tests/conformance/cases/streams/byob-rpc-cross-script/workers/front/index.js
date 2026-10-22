import { checkAll } from "#byob";

export default {
  async fetch(request, env) {
    return Response.json(await checkAll(() => env.BACK.parts()));
  },
};
