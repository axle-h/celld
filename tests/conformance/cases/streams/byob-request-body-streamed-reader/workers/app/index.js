import { check } from "#byob";

// The step's body, as streams/byob-request-body's front Worker expects it: 100
// letters.
const OWN_BODY = new TextEncoder().encode(
  Array.from({ length: 100 }, (_, i) => String.fromCharCode(97 + (i * 7) % 26)).join(""));

export default {
  async fetch(request) {
    const name = new URL(request.url).pathname.split("/")[2];
    return Response.json(await check(name, () => request.body, OWN_BODY));
  },
};
