import { CHECK_NAMES, check, parts, payload } from "#byob";

// Each check takes a body of its own, so each is a request to back.
async function forwarded(env, body) {
  const out = {};
  for (const name of CHECK_NAMES) {
    const response = await env.BACK.fetch(`http://back/${name}`, {
      method: "POST",
      body: body(),
    });
    out[name] = await response.json();
  }
  return out;
}

// What each /held/ and /streamed/ step sends: 100 letters. celld holds the
// first as bytes, and streams the second, which has no length.
const OWN_BODY = new TextEncoder().encode(
  Array.from({ length: 100 }, (_, i) => String.fromCharCode(97 + (i * 7) % 26)).join(""));

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/forwarded/parts")
      return Response.json(await forwarded(env, parts));
    if (url.pathname === "/forwarded/bytes")
      return Response.json(await forwarded(env, () => payload()));
    // The step's own body.
    const name = url.pathname.split("/")[2];
    return Response.json(await check(name, () => request.body, OWN_BODY));
  },
};
