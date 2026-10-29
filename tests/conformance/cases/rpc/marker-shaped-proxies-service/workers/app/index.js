// Proxies of objects holding celld's marker keys, over a service binding to
// another Worker. workerd stubs one presenting a plain object, as it does
// within a Worker (rpc/marker-shaped-proxies), and refuses any other. celld
// refuses the stub, since a stub cannot cross an isolate yet (plan 3.1).
import { PROXY_NAMES, object } from "#marker-shaped";

export default {
  async fetch(request, env) {
    const out = {};
    for (const name of PROXY_NAMES) {
      try {
        out[name] = await env.OTHER.probe({ v: object(name) });
      } catch (error) {
        out[name] = `${error.name}: ${error.message}`;
      }
    }
    return Response.json(out);
  },
};
