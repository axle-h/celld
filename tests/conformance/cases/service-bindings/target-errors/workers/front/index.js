// What a caller sees when another script's fetch handler returns something
// other than a Response: workerd's TypeError ("did not resolve to
// 'Response'") crosses to the caller as one; in celld it arrives as an
// Error (plan 1.63). fetch/handler-non-response covers the same refusal
// within one Worker.
export default {
  async fetch(request, env) {
    const out = {};
    for (const kind of ["proxy", "string", "undefined"]) {
      try {
        const response = await env.TARGET.fetch(`http://x/${kind}`);
        out[kind] = { status: response.status, body: await response.text() };
      } catch (error) {
        out[kind] = { error: `${error.name}: ${error.message}` };
      }
    }
    return Response.json(out);
  },
};
