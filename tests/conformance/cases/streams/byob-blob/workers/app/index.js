import { checkAll, payload } from "#byob";

const SOURCES = {
  // Trial failure 9: Cloudflare OS reads a release pack this way.
  "/blob": () => new Blob([payload()]).stream(),
  "/response": () => new Response(payload()).body,
};

export default {
  async fetch(request) {
    const make = SOURCES[new URL(request.url).pathname];
    if (make === undefined) return new Response("not found", { status: 404 });
    return Response.json(await checkAll(make));
  },
};
