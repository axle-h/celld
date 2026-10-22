import { check } from "#byob";

export default {
  async fetch(request) {
    const name = new URL(request.url).pathname.slice(1);
    return Response.json(await check(name, () => request.body));
  },
};
