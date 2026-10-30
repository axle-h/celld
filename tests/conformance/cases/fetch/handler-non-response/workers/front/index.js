// What a caller sees of a fetch handler that returns something other than
// a Response: workerd refuses it ("did not resolve to 'Response'"), so the
// call fails with a TypeError, whatever the value is shaped like. The
// handler is an entrypoint of the same Worker; another script's is
// service-bindings/target-errors' (plan 1.63).
import { WorkerEntrypoint } from "cloudflare:workers";

const RETURNS = {
  proxy: () => new Proxy(new Response("proxied"), {}),
  fake: () => Object.setPrototypeOf({}, Response.prototype),
  string: () => "a string",
  undefined: () => undefined,
  null: () => null,
  object: () => ({ status: 200, body: "object" }),
  number: () => 42,
  promiseOfString: () => Promise.resolve("promised"),
  response: () => new Response("real"),
};

export class Target extends WorkerEntrypoint {
  fetch(request) {
    return RETURNS[new URL(request.url).pathname.slice(1)]();
  }
}

export default {
  async fetch(request, env) {
    const out = {};
    for (const kind of Object.keys(RETURNS)) {
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
