// Under disallow_importable_env the proxies have no object: every name
// reads as undefined, none is listed, and a write to `env` is dropped.
import { env, exports } from "cloudflare:workers";

const atModuleScope = { keys: Object.keys(env), greeting: env.GREETING ?? null, has: "GREETING" in env };
env.ADDED = "x";

export default {
  fetch(request, handlerEnv) {
    return Response.json({
      atModuleScope,
      keys: Object.keys(env),
      greeting: env.GREETING ?? null,
      added: handlerEnv.ADDED ?? null,
      exports: Object.keys(exports),
      exportsDefault: typeof exports.default,
    });
  },
};
