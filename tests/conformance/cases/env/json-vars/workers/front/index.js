// Reports how JSON vars appear in `env`.
import { env as moduleEnv } from "cloudflare:workers";

const NAMES = ["ADMINS", "CONFIG", "LIMIT", "ENABLED", "NOTHING", "EMPTY_LIST", "LOOKS_JSON", "OVERRIDDEN"];

function describe(value) {
  return {
    type: value === null ? "null" : typeof value,
    isArray: Array.isArray(value),
    frozen: Object.isFrozen(value),
    prototype:
      value !== null && typeof value === "object"
        ? Object.getPrototypeOf(value) === Array.prototype
          ? "Array"
          : Object.getPrototypeOf(value) === Object.prototype
            ? "Object"
            : "other"
        : null,
  };
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    switch (pathname) {
      case "/shape":
        return Response.json(Object.fromEntries(NAMES.map((name) => [name, describe(env[name])])));
      case "/values":
        return Response.json({
          admins: env.ADMINS,
          includesAdmin: Array.isArray(env.ADMINS) && env.ADMINS.includes("admin"),
          nestedList: env.CONFIG.nested.list,
          third: env.CONFIG.nested.list[2].three,
          nil: env.CONFIG.nested.nil,
          text: env.CONFIG.text,
          textCodes: [...env.CONFIG.text.slice(4, 5), ...env.CONFIG.text.slice(9, 10)].map((c) => c.charCodeAt(0)),
          limit: env.LIMIT,
          enabled: env.ENABLED,
          nothing: env.NOTHING,
          emptyList: env.EMPTY_LIST,
          looksJson: env.LOOKS_JSON,
          overridden: env.OVERRIDDEN,
          keys: Object.keys(env).filter((key) => NAMES.includes(key)).sort(),
          stringified: JSON.stringify(env.CONFIG.nested),
        });
      case "/identity":
        return Response.json({
          sameObject: env.ADMINS === env.ADMINS,
          enumerable: Object.getOwnPropertyDescriptor(env, "ADMINS")?.enumerable ?? null,
        });
      case "/module-env":
        return Response.json({
          sameAsArgument: moduleEnv.ADMINS === env.ADMINS,
          admins: moduleEnv.ADMINS,
        });
      case "/mutate": {
        // Whether a change to the value outlives the request that made it.
        const before = env.ADMINS.length;
        let threw = null;
        try {
          env.ADMINS.push("mutated");
        } catch (error) {
          threw = error.constructor.name;
        }
        return Response.json({ before, threw });
      }
    }
    return new Response("not found", { status: 404 });
  },
};
