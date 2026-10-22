import { env, exports } from "cloudflare:workers";
import { REPORT } from "../../report.js";

const view = () => ({
  secret: env.SECRET ?? null,
  hasSecret: "SECRET" in env,
  envKeys: Object.keys(env).sort(),
  hasHelper: "Helper" in exports,
  helperType: typeof exports.Helper,
  exportKeys: Object.keys(exports).sort(),
});
const atLoad = view();

export class Helper {}

function dynamic(env, flags) {
  return env.LOADER.get(`report-${flags.join("-")}`, () => ({
    compatibilityDate: "2026-02-01",
    compatibilityFlags: flags,
    mainModule: "main.js",
    modules: {
      "main.js": `${REPORT}
        export default {
          fetch(request, env) {
            return Response.json({ ...report(), argSecret: env.SECRET ?? null });
          },
        };`,
    },
    env: { SECRET: "dynamic-secret" },
    globalOutbound: null,
  }));
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === "/plain") return env.PLAIN.fetch(request);
    if (path === "/dynamic") {
      const result = {};
      for (const flags of [
        ["disallow_importable_env", "allow_irrevocable_stub_storage"],
        [],
      ]) {
        const response = await dynamic(env, flags).getEntrypoint().fetch("http://dynamic/");
        result[flags.join(",") || "none"] = await response.json();
      }
      return Response.json(result);
    }
    env.WRITTEN = "x";
    return Response.json({
      atLoad,
      now: view(),
      argSecret: env.SECRET,
      reported: Cloudflare.compatibilityFlags.disallow_importable_env,
    });
  },
};
