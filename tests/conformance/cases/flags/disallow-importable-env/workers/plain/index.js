import { env, exports } from "cloudflare:workers";

const view = () => ({
  secret: env.SECRET ?? null,
  hasSecret: "SECRET" in env,
  envKeys: Object.keys(env).sort(),
  hasHelper: "Helper" in exports,
  helperType: typeof exports.Helper,
});
export class Helper {}

export default {
  fetch() {
    return Response.json({
      now: view(),
      reported: Cloudflare.compatibilityFlags.disallow_importable_env,
    });
  },
};
