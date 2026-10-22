// What `env` and `exports` from cloudflare:workers show, at module scope and
// in a request. Shared by both Workers and the Dynamic Workers.
export const REPORT = `
  import { env, exports } from "cloudflare:workers";
  const view = () => ({
    secret: env.SECRET ?? null,
    hasSecret: "SECRET" in env,
    envKeys: Object.keys(env).sort(),
    hasHelper: "Helper" in exports,
    helperType: typeof exports.Helper,
  });
  const atLoad = view();
  export class Helper {}
  export function report() {
    env.WRITTEN = "x";
    return { atLoad, now: view(), written: env.WRITTEN ?? null };
  }
`;
