// The order of the env's names, at module scope and in a handler alike:
// workerd's lists the vars first, as Wrangler's configuration gives them to
// it; celld's lists each kind of binding in its own order, the vars last.
import { env, DurableObject } from "cloudflare:workers";

const atModuleScope = Object.keys(env);

export class Obj extends DurableObject {}

export default {
  fetch(request, handlerEnv) {
    return Response.json({ atModuleScope, handler: Object.keys(handlerEnv) });
  },
};
